import { afterEach, describe, expect, it, vi } from 'vitest';

import { changeHubGroups } from '@/shared/api';
import type { HubGroup, HubGroupState } from '@/shared/types';
import { moveHubGroup } from '@/modules/remote-hub/utils/hubClient';

const group = (id: string, isPinned = false): HubGroup => ({
  id,
  name: id,
  isPinned,
  members: ['alpha', 'beta'].map(remoteId => ({
    remoteId,
    sessionId: 'same-native-id',
    title: `${remoteId} conversation`,
    projectId: `${remoteId}-project`,
    projectPath: `/srv/${remoteId}`,
    provider: 'claude'
  }))
});

const state = (): HubGroupState => ({
  revision: 12,
  imported: ['alpha', 'beta'],
  groups: [group('a'), group('pinned-a', true), group('b'), group('pinned-b', true), group('c')]
});

afterEach(() => vi.unstubAllGlobals());

describe('moveHubGroup', () => {
  it('reorders an ordinary group while preserving both machines, hidden groups and metadata', () => {
    const current = state();
    const untouched = structuredClone(current);
    const next = moveHubGroup(current, 'c', 'a', 'before');

    expect(next.groups.map(item => item.id)).toEqual(['c', 'pinned-a', 'a', 'pinned-b', 'b']);
    expect(current).toEqual(untouched);
    expect(next.revision).toBe(12);
    expect(next.imported).toBe(current.imported);
    expect(next.groups).toHaveLength(current.groups.length);
    for (const item of current.groups) expect(next.groups.find(candidate => candidate.id === item.id)).toBe(item);
  });

  it('reorders pinned groups without disturbing the ordinary section or changing pin flags', () => {
    const current = state();
    const next = moveHubGroup(current, 'pinned-a', 'pinned-b', 'after');

    expect(next.groups.map(item => item.id)).toEqual(['a', 'pinned-b', 'b', 'pinned-a', 'c']);
    expect(next.groups.filter(item => item.isPinned).map(item => item.id)).toEqual(['pinned-b', 'pinned-a']);
    expect(next.groups.filter(item => !item.isPinned)).toEqual(current.groups.filter(item => !item.isPinned));
  });

  it('does not recreate a removed source or target, or silently change a group pin section', () => {
    const current = state();
    const untouched = structuredClone(current);

    expect(() => moveHubGroup(current, 'gone', 'a', 'before')).toThrow('分组已被删除');
    expect(() => moveHubGroup(current, 'a', 'gone', 'before')).toThrow('分组已被删除');
    expect(() => moveHubGroup(current, 'a', 'pinned-a', 'after')).toThrow('同一置顶区域');
    expect(current).toEqual(untouched);
    expect(moveHubGroup(current, 'a', 'a', 'before')).toBe(current);
  });

  it('reapplies a conflicting save to the latest window state, preserving concurrent additions and edits', async () => {
    const original = state();
    const latest = state();
    latest.revision = 13;
    latest.imported.push('gamma');
    latest.groups[2].name = 'Renamed in another window';
    latest.groups[2].members.push({ ...latest.groups[2].members[0], remoteId: 'gamma', sessionId: 'new-session' });
    latest.groups.splice(2, 0, group('new-group'));
    const saves: HubGroupState[] = [];
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'PUT') return new Response(JSON.stringify(reads++ === 0 ? original : latest));
      const saved = JSON.parse(String(init.body)) as HubGroupState;
      saves.push(saved);
      return saves.length === 1
        ? new Response(null, { status: 409 })
        : new Response(JSON.stringify({ ...saved, revision: saved.revision + 1 }));
    }));

    const next = await changeHubGroups(current => moveHubGroup(current, 'c', 'a', 'before'));

    expect(reads).toBe(2);
    expect(saves.map(saved => saved.revision)).toEqual([12, 13]);
    expect(next.revision).toBe(14);
    expect(next.imported).toEqual(['alpha', 'beta', 'gamma']);
    expect(next.groups.filter(item => !item.isPinned).map(item => item.id)).toEqual(['c', 'a', 'new-group', 'b']);
    expect(next.groups.filter(item => item.isPinned).map(item => item.id)).toEqual(['pinned-a', 'pinned-b']);
    expect(next.groups.find(item => item.id === 'b')).toEqual(latest.groups.find(item => item.id === 'b'));
    expect(new Set(next.groups.map(item => item.id))).toEqual(new Set(latest.groups.map(item => item.id)));
  });

  it('rejects a retry if another window removed the target instead of overwriting its newer state', async () => {
    const original = state();
    const latest = { ...state(), revision: 13, groups: state().groups.filter(item => item.id !== 'a') };
    let reads = 0;
    let writes = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'PUT') return new Response(JSON.stringify(reads++ === 0 ? original : latest));
      writes++;
      return new Response(null, { status: 409 });
    }));

    await expect(changeHubGroups(current => moveHubGroup(current, 'c', 'a', 'before'))).rejects.toThrow('分组已被删除');
    expect(reads).toBe(2);
    expect(writes).toBe(1);
  });
});
