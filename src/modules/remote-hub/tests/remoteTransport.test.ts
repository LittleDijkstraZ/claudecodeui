import { test } from 'vitest';
import type { HubGroupState } from '@/shared/types';
import assert from 'node:assert/strict';

import { remoteTransportUrl, scopedRemoteStorage } from '@/modules/remote-transport';
import { moveHubMember, memberKey } from '@/modules/remote-hub/utils/hubClient';
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, String(value));
    },
    removeItem: key => {
      values.delete(key);
    },
    clear: () => values.clear(),
    key: index => [...values.keys()][index] ?? null
  };
}
test('remote transport scopes API, WebSocket and shell but leaves external services and assets alone', () => {
  const origin = 'http://127.0.0.1:3000',
    base = '/remote/alpha';
  for (const path of ['/api/projects', '/api/providers/sessions/same-id?offset=40', '/health']) assert.equal(remoteTransportUrl(path, origin, base), origin + base + path);
  assert.equal(remoteTransportUrl('ws://127.0.0.1:3000/ws?token=fake', origin, base), 'ws://127.0.0.1:3000/remote/alpha/ws?token=fake');
  assert.equal(remoteTransportUrl('/shell', origin, base), origin + base + '/shell');
  for (const path of ['https://example.org/api/test', '/assets/app.js', '/remote/beta/api/projects']) assert.equal(remoteTransportUrl(path, origin, base), path);
});
test('same native session ids and logout cannot cross remote storage namespaces', () => {
  const original = memoryStorage(),
    a = scopedRemoteStorage(original, 'alpha'),
    b = scopedRemoteStorage(original, 'beta');
  original.setItem('auth-token', 'standalone-token');
  a.setItem('auth-token', 'alpha-token');
  b.setItem('auth-token', 'beta-token');
  a.setItem('draft:same-id', 'alpha');
  b.setItem('draft:same-id', 'beta');
  assert.equal(a.getItem('draft:same-id'), 'alpha');
  assert.equal(b.getItem('draft:same-id'), 'beta');
  assert.equal(a.length, 2);
  a.clear();
  assert.equal(a.length, 0);
  assert.equal(b.getItem('auth-token'), 'beta-token');
  assert.equal(original.getItem('auth-token'), 'standalone-token');
});
test('cross-machine group order distinguishes colliding ids and preserves hidden rows', () => {
  const row = (remoteId: string, sessionId: string) => ({
    remoteId,
    sessionId,
    title: sessionId,
    projectId: 'same-project',
    projectPath: '/srv/work',
    provider: 'claude'
  });
  const state: HubGroupState = {
    revision: 1,
    imported: [],
    groups: [{
      id: 'g',
      name: 'Research',
      isPinned: false,
      members: [row('alpha', 'same-id'), row('beta', 'same-id'), row('alpha', 'hidden'), row('beta', 'end')]
    }]
  };
  moveHubMember(state, 'g', 'alpha:same-id', 'beta:end', 'after');
  assert.deepEqual(state.groups[0].members.map(memberKey), ['beta:same-id', 'alpha:hidden', 'beta:end', 'alpha:same-id']);
  assert.throws(() => moveHubMember(state, 'g', 'gone', 'beta:end', 'before'));
});
