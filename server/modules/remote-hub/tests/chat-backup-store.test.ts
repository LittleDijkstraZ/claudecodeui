import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createHubChatBackupStore } from '../chat-backup-store.service.js';

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
const input = (remoteId = 'one', title?: string, sourceUpdatedAt: string | null = '2026-09-09T11:00:00.000Z') => ({ remoteId, remoteName: `Remote ${remoteId}`, sourceUpdatedAt, bundle: fixtureBundle(title) });

test('local sync starts disabled and reading/refused sync creates no files', t => {
  const { directory, store } = fixture(t);
  assert.deepEqual(store.read(), { enabled: false, directory: path.join(directory, 'chat-backups'), backups: [] });
  assert.throws(() => store.sync(input()), { statusCode: 409 });
  assert.deepEqual(readdirSync(directory), []);
});

test('settings and latest source snapshots persist with private permissions and canonical metadata', t => {
  const { directory, store } = fixture(t);
  store.setEnabled(true);
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
  store.setEnabled(true);
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
  const imported = store.import(fixtureBundle(), 'Previous laptop');
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
  const imported = store.import(bundle);
  assert.deepEqual(store.get(imported.id).files, bundle.files);
  assert.throws(() => store.import({ ...bundle, session: { ...bundle.session, provider: 'codex' } }), { statusCode: 400 });
});

test('corrupt metadata disables sync safely, preserves archives, and leaves healthy copies accessible', t => {
  const { directory, store } = fixture(t);
  store.setEnabled(true);
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
  reloaded.setEnabled(true);
  assert.throws(() => reloaded.sync(input('one')), { statusCode: 500 });
  assert.equal(readFileSync(archivePath, 'utf8'), '{broken');
  assert.equal(reloaded.get(healthy.id).session.title, 'A saved chat');
});

test('symlinked archive files cannot be read or overwritten through automatic sync', t => {
  const { directory, store } = fixture(t);
  store.setEnabled(true);
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
