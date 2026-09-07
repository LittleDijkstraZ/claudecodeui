import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
const api = vi.hoisted(() => ({ forkSession: vi.fn(), deleteSession: vi.fn(), renameSession: vi.fn() }));
vi.mock('@/shared/api', () => ({ hubApi: api }));
import { HubConversationDialog } from '@/modules/remote-hub/HubConversationDialog';
const member = { remoteId: 'beta', sessionId: 'same', title: 'Study', provider: 'claude', projectId: 'p', projectPath: '/remote/project' };
beforeEach(() => { vi.resetAllMocks(); api.forkSession.mockResolvedValue({ sessionId: 'fork', sessionName: 'Branch' }); });
test('fork targets its own machine and a failed group save can retry without duplicating the fork', async () => {
  const done = vi.fn().mockRejectedValueOnce(new Error('group save failed')).mockResolvedValueOnce(undefined);
  render(<HubConversationDialog action={{ kind: 'fork', member, groupId: 'group' }} machine="Beta" busySession={false} close={vi.fn()} onDone={done} />);
  fireEvent.click(screen.getByRole('button', { name: '创建 Fork' }));
  await screen.findByRole('alert');
  expect(api.forkSession).toHaveBeenCalledWith('beta', 'same', 'claude');
  fireEvent.click(screen.getByRole('button', { name: '重试同步' }));
  await waitFor(() => expect(done).toHaveBeenCalledTimes(2));
  expect(api.forkSession).toHaveBeenCalledTimes(1);
  expect(done.mock.calls[1][1]).toMatchObject({ remoteId: 'beta', sessionId: 'fork', projectPath: '/remote/project' });
});
test('deletion defaults to recoverable archive and does not mutate another machine', async () => {
  render(<HubConversationDialog action={{ kind: 'delete', member }} machine="Beta" busySession={false} close={vi.fn()} onDone={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '归档对话' }));
  await waitFor(() => expect(api.deleteSession).toHaveBeenCalledWith('beta', 'same', false));
});
test('a run starting while confirmation is open prevents a destructive action', () => {
  render(<HubConversationDialog action={{ kind: 'delete', member }} machine="Beta" busySession close={vi.fn()} onDone={vi.fn()} />);
  expect((screen.getByRole('button', { name: '归档对话' }) as HTMLButtonElement).disabled).toBe(true);
  expect(api.deleteSession).not.toHaveBeenCalled();
});
