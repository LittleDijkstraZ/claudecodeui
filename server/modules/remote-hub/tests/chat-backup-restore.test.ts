import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ChatBackupBundle, ChatBackupGroupSnapshot, RestoredChatBackup } from '@/shared/index.js';

import type { createHubChatBackupStore } from '../chat-backup-store.service.js';
import { createHubChatBackupRestoreService } from '../chat-backup-restore.service.js';
import { createHubGroupStore } from '../remote-hub-state.js';

const first = 'a'.repeat(64);
const second = 'b'.repeat(64);
const snapshot: ChatBackupGroupSnapshot = {
  format: 'cloudcli-chat-groups', version: 1, sourceId: 'source-hub', capturedAt: '2026-09-10T01:00:00Z', revision: 8,
  groups: [
    { id: 'source-group', name: 'Important', isPinned: true, members: [{ remoteId: 'old-remote', sessionId: 'source-one' }, { remoteId: 'old-remote', sessionId: 'source-two' }] },
    { id: 'empty-group', name: 'Important', isPinned: false, members: [] },
  ], observations: [],
};
const restored = (id: string): RestoredChatBackup => ({ sessionId: id, provider: 'claude', projectPath: '/destination/project', sessionName: `Restored ${id}` });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'hub-group-restore-'));
  const groups = createHubGroupStore(directory, ['destination']);
  const context = (id: string) => ({
    sourceRemoteId: 'old-remote', groups: structuredClone(snapshot),
    bundle: { session: { id: id === first ? 'source-one' : 'source-two', provider: 'claude' } } as ChatBackupBundle,
  });
  const backups = {
    read: () => ({ sourceId: 'destination-hub' }),
    getSnapshot: () => structuredClone(snapshot), getRestoreContext: context,
  } as unknown as ReturnType<typeof createHubChatBackupStore>;
  const service = createHubChatBackupRestoreService(directory, ['destination'], backups, groups);
  return { directory, groups, backups, service, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('empty groups, names, pins and group order survive recovery without importing old remote identities', () => {
  const f = fixture();
  try {
    f.groups.replace({ revision: 0, imported: [], groups: [{ id: 'unrelated', name: 'Keep mine', isPinned: false, members: [] }] });
    const result = f.service.restoreGroups(snapshot.sourceId);
    assert.deepEqual(result.groups.map(group => [group.name, group.isPinned, group.members.length]), [['Keep mine', false, 0], ['Important', true, 0], ['Important', false, 0]]);
    assert.equal(new Set(result.groups.map(group => group.id)).size, 3);
    assert.equal(result.groups.some(group => group.id === 'source-group'), false);
    assert.equal(existsSync(join(f.directory, 'chat-backup-restores.json')), false);
    assert.equal(f.service.restoreGroups(snapshot.sourceId).groups.length, 3);
  } finally { f.cleanup(); }
});

test('restoring chats out of order recovers recorded membership order and retries do not duplicate groups or members', () => {
  const f = fixture();
  try {
    f.service.recordRestore({ backupId: second, remoteId: 'destination', result: restored('new-two') });
    const result = f.service.recordRestore({ backupId: first, remoteId: 'destination', result: restored('new-one') });
    assert.deepEqual(result.groups[0].members.map(member => member.sessionId), ['new-one', 'new-two']);
    assert.ok(result.groups[0].members.every(member => member.remoteId === 'destination'));
    f.service.recordRestore({ backupId: first, remoteId: 'destination', result: restored('new-one') });
    const reopened = createHubChatBackupRestoreService(f.directory, ['destination'], f.backups, f.groups);
    assert.deepEqual(reopened.restoreGroups(snapshot.sourceId).groups[0].members.map(member => member.sessionId), ['new-one', 'new-two']);
    assert.equal(f.groups.read().groups.length, 2);
    const saved = JSON.parse(readFileSync(join(f.directory, 'chat-backup-restores.json'), 'utf8'));
    assert.equal(saved.entries.length, 2);
    assert.equal(JSON.stringify(saved).includes('main.jsonl'), false);
  } finally { f.cleanup(); }
});

test('restoring a newer group order preserves unrelated local group positions', () => {
  const f = fixture();
  try {
    const initial = f.service.restoreGroups(snapshot.sourceId);
    const ids = initial.groups.map(group => group.id);
    const edited = structuredClone(initial);
    edited.groups.splice(1, 0, { id: 'unrelated', name: 'Keep my position', isPinned: false, members: [] });
    f.groups.replace(edited);
    f.backups.getSnapshot = () => ({ ...structuredClone(snapshot), groups: [...snapshot.groups].reverse() });
    const result = f.service.restoreGroups(snapshot.sourceId);
    assert.deepEqual(result.groups.map(group => group.id), [ids[1], 'unrelated', ids[0]]);
  } finally { f.cleanup(); }
});

test('failed group publication keeps the durable restored mapping so recovery never needs another native restore', () => {
  const f = fixture();
  try {
    const replace = f.groups.replace;
    f.groups.replace = () => ({ status: 500, body: { error: 'Fixture group write failure' } });
    assert.throws(() => f.service.recordRestore({ backupId: first, remoteId: 'destination', result: restored('native-already-created') }), /chat was restored/);
    assert.ok(existsSync(join(f.directory, 'chat-backup-restores.json')));
    f.groups.replace = replace;
    const result = f.service.restoreGroups(snapshot.sourceId);
    assert.equal(result.groups[0].members[0].sessionId, 'native-already-created');
  } finally { f.cleanup(); }
});

test('adding one restored chat preserves local edits and placement of earlier recovered chats', () => {
  const f = fixture();
  try {
    f.service.recordRestore({ backupId: second, remoteId: 'destination', result: restored('new-two') });
    const edited = structuredClone(f.groups.read());
    const moved = edited.groups[0].members.pop()!;
    edited.groups[0].name = 'Local rename';
    edited.groups.push({ id: 'my-group', name: 'My current work', isPinned: false, members: [moved] });
    f.groups.replace(edited);
    const result = f.service.recordRestore({ backupId: first, remoteId: 'destination', result: restored('new-one') });
    assert.equal(result.groups[0].name, 'Local rename');
    assert.deepEqual(result.groups.find(group => group.id === 'my-group')?.members.map(member => member.sessionId), ['new-two']);
    assert.deepEqual(result.groups[0].members.map(member => member.sessionId), ['new-one']);
  } finally { f.cleanup(); }
});

test('local-source recovery uses existing groups and preserves original conversation members', () => {
  const f = fixture();
  try {
    f.backups.read = (() => ({ sourceId: snapshot.sourceId })) as typeof f.backups.read;
    f.groups.replace({ revision: 0, imported: [], groups: [{ id: 'source-group', name: 'Existing important', isPinned: true,
      members: [{ remoteId: 'destination', sessionId: 'original-still-here', title: 'Original', provider: 'claude', projectPath: '/destination/project', projectId: '' }] }] });
    const result = f.service.recordRestore({ backupId: first, remoteId: 'destination', result: restored('new-one') });
    assert.equal(result.groups[0].id, 'source-group');
    assert.equal(result.groups[0].name, 'Existing important');
    assert.deepEqual(result.groups[0].members.map(member => member.sessionId), ['new-one', 'original-still-here']);
  } finally { f.cleanup(); }
});

test('adding another restored chat preserves the relative order of already arranged members', () => {
  const f = fixture();
  try {
    f.service.recordRestore({ backupId: second, remoteId: 'destination', result: restored('new-two') });
    const edited = structuredClone(f.groups.read());
    edited.groups[0].members.unshift({ remoteId: 'destination', sessionId: 'my-first', title: 'Pinned first', projectPath: '/destination/project', projectId: '', provider: 'claude' });
    f.groups.replace(edited);
    const result = f.service.recordRestore({ backupId: first, remoteId: 'destination', result: restored('new-one') });
    assert.deepEqual(result.groups[0].members.filter(member => member.sessionId !== 'new-one').map(member => member.sessionId), ['my-first', 'new-two']);
  } finally { f.cleanup(); }
});

test('unknown destinations, mismatched providers and unsafe member identities are rejected before any write', () => {
  const f = fixture();
  try {
    assert.throws(() => f.service.recordRestore({ backupId: first, remoteId: 'removed-remote', result: restored('new-one') }), /Invalid/);
    assert.throws(() => f.service.recordRestore({ backupId: first, remoteId: 'destination', result: { ...restored('new-one'), provider: 'codex' } }), /does not match/);
    assert.throws(() => f.service.recordRestore({ backupId: first, remoteId: 'destination', result: restored('../escape') }), /Invalid/);
    assert.equal(existsSync(join(f.directory, 'chat-backup-restores.json')), false);
    assert.equal(f.groups.read().groups.length, 0);
  } finally { f.cleanup(); }
});
