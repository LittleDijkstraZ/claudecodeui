import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import type { Project } from '@/shared/types';
import { useFileOpenResolver } from '@/modules/project-workspace/hooks/useFileOpenResolver';

const getFiles = vi.hoisted(() => vi.fn());
vi.mock('@/shared/api', () => ({ api: { getFiles } }));

const project = (projectId: string, fullPath: string): Project => ({ projectId, fullPath, path: fullPath, displayName: projectId, isStarred: false, sessions: [] });
const main = project('main', '/repo');
const worktree = project('feature', '/repo-worktrees/feature');
const response = (body: unknown) => ({ ok: true, json: async () => body } as Response);
const tree = (path: string) => [{ type: 'directory', name: 'src', path: 'src', children: [{ type: 'file', name: 'source.ts', path }] }];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

beforeEach(() => { getFiles.mockReset(); });

test('a late tree from the previous worktree cannot open its file in the new main conversation', async () => {
  const pending = deferred<Response>();
  getFiles.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(response(tree('feature/source.ts')));
  const onFileOpen = vi.fn();
  const hook = renderHook(({ selectedProject }) => useFileOpenResolver(selectedProject, onFileOpen), { initialProps: { selectedProject: main } });
  act(() => hook.result.current('source.ts'));
  hook.rerender({ selectedProject: worktree });
  await act(async () => hook.result.current('source.ts'));
  expect(onFileOpen).toHaveBeenCalledExactlyOnceWith('feature/source.ts', undefined);
  await act(async () => { pending.resolve(response(tree('main/source.ts'))); });
  expect(onFileOpen).toHaveBeenCalledTimes(1);
});

test('A to B to A invalidates the old A request and callback, and obtains a fresh tree', async () => {
  const pending = deferred<Response>();
  getFiles.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(response(tree('fresh/source.ts')));
  const onFileOpen = vi.fn();
  const hook = renderHook(({ selectedProject }) => useFileOpenResolver(selectedProject, onFileOpen), { initialProps: { selectedProject: main } });
  const oldOpen = hook.result.current;
  act(() => oldOpen('source.ts'));
  hook.rerender({ selectedProject: worktree });
  hook.rerender({ selectedProject: main });
  await act(async () => { oldOpen('source.ts'); pending.resolve(response(tree('old/source.ts'))); });
  expect(onFileOpen).not.toHaveBeenCalled();
  expect(getFiles).toHaveBeenCalledTimes(1);
  await act(async () => hook.result.current('source.ts'));
  expect(getFiles).toHaveBeenCalledTimes(2);
  expect(onFileOpen).toHaveBeenCalledExactlyOnceWith('fresh/source.ts', undefined);
});

test('unmount invalidates both a pending lookup and a retained callback', async () => {
  const pending = deferred<Response>();
  getFiles.mockReturnValue(pending.promise);
  const onFileOpen = vi.fn();
  const hook = renderHook(() => useFileOpenResolver(main, onFileOpen));
  const open = hook.result.current;
  act(() => open('source.ts'));
  hook.unmount();
  await act(async () => { pending.resolve(response(tree('src/source.ts'))); open('source.ts'); });
  expect(onFileOpen).not.toHaveBeenCalled();
  expect(getFiles).toHaveBeenCalledTimes(1);
});

test('same-folder lookups share the tree cache, preserve diff details and resolve partial paths before basenames', async () => {
  getFiles.mockResolvedValue(response([{ type: 'file', name: 'source.ts', path: 'other/source.ts' }, ...tree('src/source.ts')]));
  const onFileOpen = vi.fn();
  const hook = renderHook(({ selectedProject }) => useFileOpenResolver(selectedProject, onFileOpen), { initialProps: { selectedProject: main } });
  const diff = { old_string: 'before', new_string: 'after' };
  await act(async () => { hook.result.current('.\\src\\source.ts', diff); hook.result.current('missing.ts'); });
  expect(onFileOpen).toHaveBeenNthCalledWith(1, 'src/source.ts', diff);
  expect(onFileOpen).toHaveBeenNthCalledWith(2, 'missing.ts', undefined);
  hook.rerender({ selectedProject: { ...main, displayName: 'Renamed' } });
  await act(async () => hook.result.current('source.ts'));
  expect(onFileOpen).toHaveBeenLastCalledWith('other/source.ts', undefined);
  expect(getFiles).toHaveBeenCalledTimes(1);
});

test('changing the folder under the same project ID invalidates its cached tree', async () => {
  getFiles.mockResolvedValueOnce(response(tree('main/source.ts'))).mockResolvedValueOnce(response(tree('relocated/source.ts')));
  const onFileOpen = vi.fn();
  const hook = renderHook(({ selectedProject }) => useFileOpenResolver(selectedProject, onFileOpen), { initialProps: { selectedProject: main } });
  await act(async () => hook.result.current('source.ts'));
  hook.rerender({ selectedProject: { ...main, fullPath: '/relocated', path: '/relocated' } });
  await act(async () => hook.result.current('source.ts'));
  expect(getFiles).toHaveBeenCalledTimes(2);
  expect(onFileOpen).toHaveBeenLastCalledWith('relocated/source.ts', undefined);
});

test('a current failed lookup still falls back to the original reference', async () => {
  getFiles.mockRejectedValue(new Error('offline'));
  const onFileOpen = vi.fn();
  const hook = renderHook(() => useFileOpenResolver(main, onFileOpen));
  await act(async () => hook.result.current('./source.ts'));
  expect(onFileOpen).toHaveBeenCalledExactlyOnceWith('./source.ts', undefined);
});
