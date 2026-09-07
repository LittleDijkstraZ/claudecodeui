import type { ComponentProps } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { HubDialog } from '@/modules/remote-hub/modals/HubDialog';
import type { HubProject, HubRemoteState } from '@/shared/types';

const api = vi.hoisted(() => ({ browseDirectories: vi.fn(), projects: vi.fn(), registerProject: vi.fn(), createSession: vi.fn() }));
vi.mock('@/shared/api', () => ({ hubApi: api }));
const project = (remote: string, path = `/srv/${remote}/existing`, id = 'same-project'): HubProject => ({ projectId: id, displayName: `${remote} project`, fullPath: path, sessions: [] });
const remotes = [{ id: 'alpha', name: 'Alpha', port: 41111 }, { id: 'beta', name: 'Beta', port: 41112 }];
const states = Object.fromEntries(remotes.map(remote => [remote.id, { status: 'online', projects: [project(remote.id)], conversations: [], total: 0, running: [], attention: [] }])) as Record<string, HubRemoteState>;
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const setup = (extra: Partial<ComponentProps<typeof HubDialog>> = {}) => {
  const props = { modal: { kind: 'new' as const }, groups: [], remotes, states, close: vi.fn(), onAssign: vi.fn(), onUpdate: vi.fn(), onCreated: vi.fn(), ...extra };
  const view = render(<HubDialog {...props} />);
  return { ...view, props };
};
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear();
  api.browseDirectories.mockImplementation(async (remote: string, path: string) => ({ path: path === '~' ? `/srv/${remote}` : path.replace('~', `/srv/${remote}`), suggestions: [] }));
  api.projects.mockResolvedValue([]);
  api.registerProject.mockImplementation(async (remote: string, path: string) => ({ project: project(remote, path, 'registered-project') }));
  api.createSession.mockResolvedValue({ sessionId: 'new-session', sessionName: 'New conversation' });
});

test('a typed folder is validated and canonicalized on the selected remote before registration and creation', async () => {
  const { props } = setup();
  fireEvent.change(screen.getByLabelText('机器'), { target: { value: 'beta' } });
  fireEvent.change(screen.getByLabelText('远端文件夹路径'), { target: { value: '~/new research' } });
  fireEvent.click(screen.getByRole('button', { name: '创建对话' }));
  await waitFor(() => expect(props.onCreated).toHaveBeenCalled());
  expect(api.browseDirectories).toHaveBeenCalledWith('beta', '~/new research');
  expect(api.registerProject).toHaveBeenCalledWith('beta', '/srv/beta/new research');
  expect(api.createSession).toHaveBeenCalledWith('beta', { provider: 'claude', projectPath: '/srv/beta/new research' });
  expect(api.browseDirectories.mock.invocationCallOrder[0]).toBeLessThan(api.registerProject.mock.invocationCallOrder[0]);
  expect(api.registerProject.mock.invocationCallOrder[0]).toBeLessThan(api.createSession.mock.invocationCallOrder[0]);
  expect(vi.mocked(props.onCreated).mock.calls[0][0]).toMatchObject({ remoteId: 'beta', projectId: 'registered-project', projectPath: '/srv/beta/new research' });
  expect(JSON.parse(localStorage.getItem('cloudcli-hub-last-folder')!)).toEqual({ remoteId: 'beta', paths: { beta: '/srv/beta/new research' } });
});

test('missing or denied directories cannot register a project or create a session', async () => {
  api.browseDirectories.mockRejectedValue(new Error('Directory not accessible'));
  setup(); fireEvent.change(screen.getByLabelText('远端文件夹路径'), { target: { value: '/not-there' } });
  fireEvent.click(screen.getByRole('button', { name: '创建对话' }));
  await screen.findByText('Directory not accessible');
  expect(api.registerProject).not.toHaveBeenCalled(); expect(api.createSession).not.toHaveBeenCalled();
});

test('switching machines rejects late directory results and preserves separate path drafts', async () => {
  const pending = deferred<{ path: string; suggestions: [] }>();
  api.browseDirectories.mockReturnValueOnce(pending.promise);
  setup(); fireEvent.change(screen.getByLabelText('远端文件夹路径'), { target: { value: '/srv/alpha/first' } });
  fireEvent.click(screen.getByRole('button', { name: '浏览' }));
  const signal = api.browseDirectories.mock.calls[0][2].signal as AbortSignal;
  fireEvent.change(screen.getByLabelText('机器'), { target: { value: 'beta' } });
  fireEvent.change(screen.getByLabelText('远端文件夹路径'), { target: { value: '/srv/beta/second' } });
  expect(signal.aborted).toBe(true);
  await act(async () => { pending.resolve({ path: '/srv/alpha/late', suggestions: [] }); await pending.promise; });
  expect((screen.getByLabelText('远端文件夹路径') as HTMLInputElement).value).toBe('/srv/beta/second');
  fireEvent.change(screen.getByLabelText('机器'), { target: { value: 'alpha' } });
  expect((screen.getByLabelText('远端文件夹路径') as HTMLInputElement).value).toBe('/srv/alpha/first');
});

test('browsing enters remote children and supports hidden folders and server-resolved parent navigation', async () => {
  api.browseDirectories.mockResolvedValueOnce({ path: '/srv/alpha', suggestions: [{ name: 'research', path: '/srv/alpha/research' }, { name: '.private', path: '/srv/alpha/.private' }] });
  setup(); fireEvent.click(screen.getByRole('button', { name: '浏览' }));
  await screen.findByRole('button', { name: 'research' });
  expect(screen.queryByRole('button', { name: '.private' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '显示隐藏文件夹' }));
  expect(screen.getByRole('button', { name: '.private' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'research' }));
  await waitFor(() => expect((screen.getByLabelText('远端文件夹路径') as HTMLInputElement).value).toBe('/srv/alpha/research'));
  fireEvent.click(screen.getByRole('button', { name: '上一级文件夹' }));
  await waitFor(() => expect(api.browseDirectories).toHaveBeenLastCalledWith('alpha', '/srv/alpha/research/..', expect.anything()));
});

test('existing projects skip registration and failed group assignment retries the same created session', async () => {
  const assign = vi.fn().mockRejectedValueOnce(new Error('Group save failed')).mockResolvedValue(undefined);
  const { props } = setup({ modal: { kind: 'new', groupId: 'g', remoteId: 'alpha', projectId: 'same-project' }, groups: [{ id: 'g', name: 'Group', isPinned: false, members: [] }], onAssign: assign });
  expect((screen.getByLabelText('远端文件夹路径') as HTMLInputElement).value).toBe('/srv/alpha/existing');
  fireEvent.click(screen.getByRole('button', { name: '创建对话' })); await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: '创建对话' })); await waitFor(() => expect(props.onCreated).toHaveBeenCalled());
  expect(api.registerProject).not.toHaveBeenCalled(); expect(api.createSession).toHaveBeenCalledTimes(1); expect(api.browseDirectories).toHaveBeenCalledTimes(1); expect(assign).toHaveBeenCalledTimes(2);
});

test('remembered paths stay machine-scoped even when project IDs collide and explicit project opening overrides them', () => {
  localStorage.setItem('cloudcli-hub-last-folder', JSON.stringify({ remoteId: 'beta', paths: { alpha: '/srv/alpha/remembered', beta: '/srv/beta/remembered' } }));
  const view = setup();
  expect((screen.getByLabelText('远端文件夹路径') as HTMLInputElement).value).toBe('/srv/beta/remembered');
  fireEvent.change(screen.getByLabelText('机器'), { target: { value: 'alpha' } });
  expect((screen.getByLabelText('远端文件夹路径') as HTMLInputElement).value).toBe('/srv/alpha/remembered');
  view.unmount();setup({ modal: { kind: 'new', remoteId: 'alpha', projectId: 'same-project' } });
  expect((screen.getByLabelText('远端文件夹路径') as HTMLInputElement).value).toBe('/srv/alpha/existing');
});

test('an already registered folder from another window can recover a registration conflict', async () => {
  api.registerProject.mockRejectedValue(new Error('Project already exists'));
  api.projects.mockResolvedValueOnce([]).mockResolvedValueOnce([project('alpha', '/srv/alpha/new', 'concurrent-project')]);
  const { props } = setup();fireEvent.change(screen.getByLabelText('远端文件夹路径'), { target: { value: '/srv/alpha/new' } });fireEvent.click(screen.getByRole('button', { name: '创建对话' }));
  await waitFor(() => expect(props.onCreated).toHaveBeenCalled());
  expect(vi.mocked(props.onCreated).mock.calls[0][0]).toMatchObject({ projectId: 'concurrent-project' });expect(api.createSession).toHaveBeenCalledTimes(1);
});
