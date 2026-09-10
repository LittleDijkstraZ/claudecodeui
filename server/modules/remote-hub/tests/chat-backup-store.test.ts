import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createHubChatBackupStore } from '../chat-backup-store.service.js';
import { createHubGroupStore } from '../remote-hub-state.js';

const fixtureBundle = (title = 'A saved chat', createdAt = '2026-09-09T12:00:00.000Z') => ({
  format: 'cloudcli-chat-backup', version: 1, createdAt,
  session: { id: 'same-session', provider: 'claude', title, projectPath: '/source/project', providerSessionId: 'native-session', model: null, effort: null },
  files: [{ path: 'main.jsonl', content: '{"text":"hello"}\n' }],
});
const fixture = (t: { after: (callback: () => void) => void }) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cloudcli-backup-store-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, store: createHubChatBackupStore(directory, ['one', 'two']) };
};
const input = (remoteId = 'one', title?: string, sourceUpdatedAt: string | null = '2026-09-09T11:00:00.000Z') => ({ remoteId, remoteName: `Remote ${remoteId}`, sourceUpdatedAt, bundle: fixtureBundle(title), settingsRevision: 1, contentVersion: null });

test('local sync starts disabled and reading/refused sync creates no files', t => {
  const { directory, store } = fixture(t);
  assert.deepEqual(store.read(), { enabled: false, scope: 'grouped', settingsRevision: 0, sourceId: null, directory: path.join(directory, 'chat-backups'), backups: [], snapshots: [] });
  assert.throws(() => store.sync(input()), { statusCode: 409 });
  assert.deepEqual(readdirSync(directory), []);
});

test('settings and latest source snapshots persist with private permissions and canonical metadata', t => {
  const { directory, store } = fixture(t);
  store.setSettings({ enabled: true, scope: 'all' });
  const firstInput = input();
  const first = store.sync({ ...firstInput, bundle: { ...firstInput.bundle, authorization: 'secret-must-not-persist', session: { ...firstInput.bundle.session, token: 'secret-must-not-persist' } } });
  const second = store.sync(input('one', 'Updated chat', '2026-09-09T12:00:00.000Z'));
  assert.equal(first.id, second.id);
  const reloaded = createHubChatBackupStore(directory, ['one', 'two']);
  assert.equal(reloaded.read().enabled, true);
  assert.equal(reloaded.read().backups.length, 1);
  assert.equal(reloaded.get(first.id).session.title, 'Updated chat');
  assert.equal(statSync(path.join(directory, 'chat-backups')).mode & 0o777, 0o700);
  assert.equal(statSync(path.join(directory, 'chat-backups', `${first.id}.json`)).mode & 0o777, 0o600);
  assert.equal(statSync(path.join(directory, 'chat-backup-settings.json')).mode & 0o777, 0o600);
  assert.ok(!readFileSync(path.join(directory, 'chat-backups', `${first.id}.json`), 'utf8').includes('secret-must-not-persist'));
  store.setEnabled(false);
  assert.throws(() => reloaded.sync(input()), { statusCode: 409 });
  assert.equal(reloaded.get(first.id).session.title, 'Updated chat');
});

test('source identities stay isolated and older in-flight snapshots cannot replace newer content', t => {
  const { store } = fixture(t);
  store.setSettings({ enabled: true, scope: 'all' });
  const newer = store.sync(input('one', 'Newer', '2026-09-09T13:00:00.000Z'));
  const differentRemote = store.sync(input('two', 'Other remote'));
  const differentProviderInput = input();
  const differentProvider = store.sync({ ...differentProviderInput, bundle: { ...differentProviderInput.bundle, session: { ...differentProviderInput.bundle.session, provider: 'codex' } } });
  assert.equal(new Set([newer.id, differentRemote.id, differentProvider.id]).size, 3);
  assert.equal(store.sync(input('one', 'Older')).title, 'Newer');
  assert.equal(store.sync(input('one', 'Unknown timestamp', null)).title, 'Newer');
  assert.equal(store.sync({ ...input('one', 'Older export', '2026-09-09T13:00:00.000Z'), bundle: fixtureBundle('Older export', '2026-09-09T11:00:00.000Z') }).title, 'Newer');
  assert.equal(store.get(newer.id).session.title, 'Newer');
  assert.throws(() => store.sync(input('unknown')), { statusCode: 400 });
});

test('explicit portable imports work with sync off and remain readable after source removal', t => {
  const { directory, store } = fixture(t);
  const imported = store.import(fixtureBundle(), 'Previous laptop').backup!;
  assert.equal(imported.remoteId, 'imported');
  assert.equal(store.read().enabled, false);
  assert.deepEqual(store.get(imported.id), fixtureBundle());
  const reloaded = createHubChatBackupStore(directory, []);
  assert.deepEqual(reloaded.get(imported.id), fixtureBundle());
  assert.equal(reloaded.read().backups[0].remoteName, 'Previous laptop');
  reloaded.remove(imported.id);
  assert.equal(reloaded.read().backups.length, 0);
  assert.throws(() => reloaded.get(imported.id), { statusCode: 404 });
});

test('invalid envelopes, unsupported files, unsafe paths and oversized bundles never reach disk', t => {
  const { directory, store } = fixture(t);
  const original = fixtureBundle();
  for (const invalid of [null, [], {}, { ...original, version: 2 }, { ...original, createdAt: 'bad' }, { ...original, files: [] }, { ...original, session: { ...original.session, provider: 'cursor' } }, { ...original, session: { ...original.session, providerSessionId: '' } }]) {
    assert.throws(() => store.import(invalid), { statusCode: 400 });
  }
  for (const filePath of ['../main.jsonl', '/tmp/main.jsonl', 'C:\\main.jsonl', 'subagents/../evil.jsonl', 'subagents//evil.jsonl', 'subagents/%2e%2e/evil.jsonl', 'settings.json', 'subagents/id/settings.json']) {
    assert.throws(() => store.import({ ...original, files: [...original.files, { path: filePath, content: 'fixture' }] }), { statusCode: 400 });
  }
  assert.throws(() => store.import({ ...original, files: [...original.files, ...original.files] }), { statusCode: 400 });
  assert.throws(() => store.import({ ...original, files: [{ path: 'main.jsonl', content: 'x'.repeat(64 * 1024 * 1024) }] }), { statusCode: 413 });
  assert.throws(() => store.get('../../outside'), { statusCode: 400 });
  assert.throws(() => store.remove('../../outside'), { statusCode: 400 });
  assert.deepEqual(readdirSync(directory), []);
});

test('allowed Claude sidecars are opaque, while Codex archives contain only their main transcript', t => {
  const { store } = fixture(t);
  const bundle = fixtureBundle();
  bundle.files.push({ path: 'subagents/agent-a.meta.json', content: '{"fixture":true}' }, { path: 'tool-results/result-1.txt', content: 'fixture tool output' });
  const imported = store.import(bundle).backup!;
  assert.deepEqual(store.get(imported.id).files, bundle.files);
  assert.throws(() => store.import({ ...bundle, session: { ...bundle.session, provider: 'codex' } }), { statusCode: 400 });
});

test('corrupt metadata disables sync safely, preserves archives, and leaves healthy copies accessible', t => {
  const { directory, store } = fixture(t);
  store.setSettings({ enabled: true, scope: 'all' });
  const broken = store.sync(input('one')); const healthy = store.sync(input('two'));
  const archivePath = path.join(directory, 'chat-backups', `${broken.id}.json`);
  writeFileSync(archivePath, '{broken');
  writeFileSync(path.join(directory, 'chat-backup-settings.json'), '{broken');
  // A running Hub must invalidate a cached summary when its archive changes externally.
  assert.deepEqual(store.read().backups.map(backup => backup.id), [healthy.id]);
  assert.equal(store.read().warnings?.length, 2);
  const reloaded = createHubChatBackupStore(directory, ['one', 'two']);
  const status = reloaded.read();
  assert.equal(status.enabled, false);
  assert.equal(status.warnings?.length, 2);
  assert.deepEqual(status.backups.map(backup => backup.id), [healthy.id]);
  assert.throws(() => reloaded.get(broken.id), { statusCode: 500 });
  reloaded.setSettings({ enabled: true, scope: 'all' });
  assert.throws(() => reloaded.sync(input('one')), { statusCode: 500 });
  assert.equal(readFileSync(archivePath, 'utf8'), '{broken');
  assert.equal(reloaded.get(healthy.id).session.title, 'A saved chat');
});

test('symlinked archive files cannot be read or overwritten through automatic sync', t => {
  const { directory, store } = fixture(t);
  store.setSettings({ enabled: true, scope: 'all' });
  const backup = store.sync(input());
  const archivePath = path.join(directory, 'chat-backups', `${backup.id}.json`);
  const outside = path.join(directory, 'outside.json');
  writeFileSync(outside, readFileSync(archivePath));
  rmSync(archivePath); symlinkSync(outside, archivePath);
  assert.throws(() => store.get(backup.id), { statusCode: 500 });
  assert.throws(() => store.sync(input()), { statusCode: 500 });
  assert.equal(store.read().backups.length, 0);
  assert.equal(store.read().warnings?.length, 1);
  assert.equal(JSON.parse(readFileSync(outside, 'utf8')).bundle.session.title, 'A saved chat');
});

const groupMember = (remoteId = 'one', sessionId = 'same-session') => ({ remoteId, sessionId, title: 'Member', projectId: 'project', projectPath: '/project', provider: 'claude' });
const observation = (remoteId = 'one', title = 'Observed title', observedAt = '2026-09-10T12:00:00Z') => ({ remoteId, remoteName: remoteId, sessionId: 'same-session', provider: 'claude', title,
  projectId: 'project', projectPath: '/source/project', model: 'claude-fable-5-1', effort: 'high', isArchived: true, updatedAt: '2026-09-09T11:00:00Z',
  history: 'native', contentVersion: 'version-1', runtimeStatus: 'running', observedAt, attention: true });
const groupFixture = (t: { after: (callback: () => void) => void }) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cloudcli-group-backup-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const groups = createHubGroupStore(directory, ['one', 'two'], () => store.captureGroups());
  const store = createHubChatBackupStore(directory, ['one', 'two'], groups);
  return { directory, store, groups };
};

test('fresh settings default to grouped while old enabled and disabled settings retain all scope', t => {
  const { directory, store } = fixture(t);
  assert.equal(store.read().scope, 'grouped');
  for (const enabled of [true, false]) {
    writeFileSync(path.join(directory, 'chat-backup-settings.json'), JSON.stringify({ enabled }));
    const reloaded = createHubChatBackupStore(directory, ['one']);
    assert.equal(reloaded.read().scope, 'all');
    assert.equal(reloaded.read().enabled, enabled);
    assert.equal(reloaded.read().settingsRevision, 0);
  }
});

test('group structure is captured immediately on opt-in and each authoritative change without content exports', t => {
  const { directory, store, groups } = groupFixture(t);
  groups.replace({ revision: 0, groups: [{ id: 'empty', name: 'Empty group', isPinned: true, members: [] }], imported: [] });
  assert.deepEqual(store.read().snapshots, []);
  assert.ok(!readdirSync(directory).includes('chat-backup-source.json'));
  const enabled = store.setEnabled(true);
  const sourceId = enabled.sourceId!;
  assert.equal(enabled.scope, 'grouped');
  assert.deepEqual(store.getSnapshot(sourceId).groups, [{ id: 'empty', name: 'Empty group', isPinned: true, members: [] }]);
  groups.replace({ revision: 1, groups: [{ id: 'new', name: 'New group', isPinned: false, members: [groupMember('two'), groupMember()] }, { id: 'empty', name: 'Renamed', isPinned: false, members: [] }], imported: [] });
  assert.deepEqual(store.getSnapshot(sourceId).groups.map(row => [row.id, row.name, row.members.map(member => member.remoteId)]), [['new', 'New group', ['two', 'one']], ['empty', 'Renamed', []]]);
  assert.equal(store.read().backups.length, 0);
  store.setEnabled(false);
  const saved = store.getSnapshot(sourceId);
  groups.replace({ revision: 2, groups: [], imported: [] });
  assert.deepEqual(store.getSnapshot(sourceId), saved);
  store.setEnabled(true);
  assert.equal(store.read().sourceId, sourceId);
  assert.deepEqual(store.getSnapshot(sourceId).groups, []);
  assert.equal(statSync(path.join(directory, 'chat-backup-groups', `${sourceId}.json`)).mode & 0o777, 0o600);
  assert.equal(statSync(path.join(directory, 'chat-backup-source.json')).mode & 0o777, 0o600);
});

test('scope and revision reject old pending content writes and membership changes without deleting archives', t => {
  const { store, groups } = groupFixture(t);
  store.setEnabled(true);
  assert.throws(() => store.sync(input()), { statusCode: 409 });
  groups.replace({ revision: 0, groups: [{ id: 'g', name: 'Group', isPinned: false, members: [groupMember()] }], imported: [] });
  const saved = store.sync({ ...input(), contentVersion: 'v1' });
  assert.equal(store.read().backups[0].contentVersion, 'v1');
  groups.replace({ revision: 1, groups: [], imported: [] });
  assert.throws(() => store.sync(input()), { statusCode: 409 });
  assert.equal(store.get(saved.id).session.id, 'same-session');
  const all = store.setSettings({ scope: 'all', settingsRevision: 1 });
  assert.equal(all.settingsRevision, 2);
  assert.throws(() => store.sync(input()), { statusCode: 409 });
  store.sync({ ...input('two'), settingsRevision: 2 });
  assert.throws(() => store.setSettings({ enabled: false, settingsRevision: 1 }), { statusCode: 409 });
  store.setSettings({ scope: 'grouped' });
  assert.throws(() => store.sync({ ...input('two'), settingsRevision: 2 }), { statusCode: 409 });
  assert.equal(store.read().backups.length, 2);
});

test('metadata observations merge monotonically while offline/ungrouped rows cannot erase or replace existing state', t => {
  const { store, groups } = groupFixture(t);
  groups.replace({ revision: 0, groups: [{ id: 'g', name: 'Group', isPinned: false, members: [groupMember()] }], imported: [] });
  const sourceId = store.setEnabled(true).sourceId!;
  const first = observation();
  store.observe({ settingsRevision: 1, observations: [first, observation('two')] });
  assert.equal(store.getSnapshot(sourceId).observations.length, 1);
  store.observe({ settingsRevision: 1, observations: [] });
  store.observe({ settingsRevision: 1, observations: [observation('one', 'Stale', '2026-09-10T11:00:00Z')] });
  assert.equal(store.getSnapshot(sourceId).observations[0].title, 'Observed title');
  groups.replace({ revision: 1, groups: [], imported: [] });
  store.observe({ settingsRevision: 1, observations: [observation('one', 'Excluded', '2026-09-10T13:00:00Z')] });
  assert.equal(store.getSnapshot(sourceId).observations[0].title, 'Observed title');
  store.setSettings({ scope: 'all' });
  store.observe({ settingsRevision: 2, observations: [{ ...observation('one', 'New state', '2026-09-10T14:00:00Z'), isArchived: false, attention: false, runtimeStatus: 'idle', history: 'empty', contentVersion: null }] });
  const latest = store.getSnapshot(sourceId).observations[0];
  assert.deepEqual([latest.title, latest.isArchived, latest.attention, latest.runtimeStatus, latest.history], ['New state', false, false, 'idle', 'empty']);
  assert.throws(() => store.observe({ settingsRevision: 1, observations: [] }), { statusCode: 409 });
  assert.throws(() => store.observe({ settingsRevision: 2, observations: [observation('unknown')] }), { statusCode: 400 });
  store.setEnabled(false);
  assert.throws(() => store.observe({ settingsRevision: 3, observations: [] }), { statusCode: 409 });
});

test('metadata-only changes update summaries, native restore and portable exports without rewriting transcript content', t => {
  const { directory, store } = groupFixture(t);
  const sourceId = store.setSettings({ enabled: true, scope: 'all' }).sourceId!;
  const saved = store.sync({ ...input(), contentVersion: 'version-1' });
  const before = readFileSync(path.join(directory, 'chat-backups', `${saved.id}.json`), 'utf8');
  store.observe({ settingsRevision: 1, observations: [observation()] });
  assert.equal(store.read().backups[0].title, 'Observed title');
  const exported = store.exportBackup(saved.id);
  assert.equal(exported.groups?.sourceId, sourceId);
  assert.equal(exported.bundle.session.title, 'Observed title');
  assert.equal(exported.bundle.session.model, 'claude-fable-5-1');
  assert.equal(exported.bundle.session.effort, 'high');
  assert.equal(store.get(saved.id).session.title, 'Observed title');
  assert.deepEqual(exported.bundle.files, fixtureBundle().files);
  assert.equal(readFileSync(path.join(directory, 'chat-backups', `${saved.id}.json`), 'utf8'), before);
  assert.equal(store.getRestoreContext(saved.id).sourceRemoteId, 'one');
});

test('portable wrapper and standalone snapshot imports preserve foreign source identities and group membership while off', t => {
  const source = groupFixture(t); const destination = fixture(t);
  source.groups.replace({ revision: 0, groups: [{ id: 'g', name: 'Group', isPinned: true, members: [groupMember()] }, { id: 'empty', name: 'Empty', isPinned: false, members: [] }], imported: [] });
  source.store.setEnabled(true);
  const saved = source.store.sync(input());
  source.store.observe({ settingsRevision: 1, observations: [observation()] });
  const exported = source.store.exportBackup(saved.id);
  const imported = destination.store.import(exported);
  assert.equal(destination.store.read().enabled, false);
  assert.equal(destination.store.read().sourceId, null);
  assert.equal(imported.backup?.remoteId, 'imported');
  assert.deepEqual(destination.store.exportBackup(imported.backup!.id), exported);
  const reloaded = createHubChatBackupStore(destination.directory, []);
  assert.deepEqual(reloaded.getRestoreContext(imported.backup!.id), { sourceRemoteId: 'one', bundle: exported.bundle, groups: exported.groups });
  const anotherRemote = reloaded.import({ ...exported, sourceRemoteId: 'two' }).backup!;
  assert.notEqual(anotherRemote.id, imported.backup!.id);
  const newer = { ...exported.groups!, revision: 10, capturedAt: '2027-01-01T00:00:00Z', groups: [{ id: 'new', name: 'New group', isPinned: false, members: [] }] };
  assert.equal(reloaded.import(newer).snapshot?.revision, 10);
  reloaded.import(exported.groups);
  assert.equal(reloaded.getSnapshot(newer.sourceId).revision, 10);
  assert.equal(reloaded.exportBackup(imported.backup!.id).groups?.groups[0].id, 'new');
});

test('invalid, duplicate, oversized and corrupt group snapshots are rejected without replacing saved records', t => {
  const { directory, store } = fixture(t);
  const snapshot = { format: 'cloudcli-chat-groups', version: 1, sourceId: '11111111-1111-4111-8111-111111111111', capturedAt: '2026-09-10T12:00:00Z', revision: 0, groups: [], observations: [observation()] };
  assert.throws(() => store.import({ ...snapshot, sourceId: '../outside' }), { statusCode: 400 });
  assert.throws(() => store.import({ ...snapshot, observations: [...snapshot.observations, ...snapshot.observations] }), { statusCode: 400 });
  assert.throws(() => store.import({ ...snapshot, observations: [{ ...observation(), attention: 'unknown' }] }), { statusCode: 400 });
  assert.throws(() => store.import({ ...snapshot, observations: Array.from({ length: 2100 }, (_, index) => ({ ...observation(), sessionId: `session-${index}`, title: 'x'.repeat(4000) })) }), { statusCode: 413 });
  assert.deepEqual(readdirSync(directory), []);
  store.import(snapshot);
  const file = path.join(directory, 'chat-backup-groups', `${snapshot.sourceId}.json`);
  writeFileSync(file, '{broken');
  assert.throws(() => store.import(snapshot), { statusCode: 500 });
  assert.equal(readFileSync(file, 'utf8'), '{broken');
  assert.equal(store.read().warnings?.length, 1);
});

test('group writes remain successful when independent snapshot persistence fails', t => {
  const { directory, store, groups } = groupFixture(t);
  const sourceId = store.setEnabled(true).sourceId!;
  const snapshotPath = path.join(directory, 'chat-backup-groups', `${sourceId}.json`);
  writeFileSync(snapshotPath, '{broken');
  const result = groups.replace({ revision: 0, groups: [{ id: 'empty', name: 'Empty', isPinned: false, members: [] }], imported: [] });
  assert.equal(result.status, 200);
  assert.equal(groups.read().groups[0].name, 'Empty');
  assert.match(store.read().warnings?.join(' ') ?? '', /Could not update the group backup/);
  assert.equal(readFileSync(snapshotPath, 'utf8'), '{broken');
});
