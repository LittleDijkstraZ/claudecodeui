import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { hubApi } from '@/shared/api';
import { remoteStorageKey } from '@/shared/utils';

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

test('folder text stays encoded data under the selected machine and its own credentials', async () => {
  localStorage.setItem(remoteStorageKey('beta', 'auth-token'), 'beta-fixture-token');
  localStorage.setItem(remoteStorageKey('alpha', 'auth-token'), 'alpha-fixture-token');
  const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ path: '/srv/beta/research', suggestions: [{ name: 'child', path: '/srv/beta/research/child' }] }), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  const path = '~/research ?&remote=alpha/https://example.invalid';
  await hubApi.browseDirectories('beta', path);
  expect(fetch).toHaveBeenCalledWith(`/remote/beta/api/file-tree/browse-filesystem?path=${encodeURIComponent(path)}`, expect.objectContaining({ redirect: 'error', headers: { Authorization: 'Bearer beta-fixture-token' } }));
  await hubApi.registerProject('beta', '/srv/beta/research');
  expect(fetch).toHaveBeenLastCalledWith('/remote/beta/api/projects/create-project', expect.objectContaining({ redirect: 'error', method: 'POST', body: JSON.stringify({ path: '/srv/beta/research' }) }));
});

test('malformed directory responses cannot be treated as a validated folder', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ suggestions: [] }), { status: 200 })));
  await expect(hubApi.browseDirectories('alpha', '~')).rejects.toThrow('远端未返回有效的文件夹列表');
});
