import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useProjectsState } from '@/modules/project-workspace/hooks/useProjectsState';
import type { Project, ProjectSession, ServerEvent } from '@/shared/types';

const project: Project = {
  projectId: 'project-1', path: '/fixture', fullPath: '/fixture', displayName: 'Fixture',
  sessions: [{ id: 'one', messageCount: 2, lastMessage: 'earlier', lastActivity: '2026-01-01T00:00:00Z' }, { id: 'two', messageCount: 4, lastMessage: 'other', lastActivity: '2026-01-01T00:00:00Z' }],
  sessionMeta: { total: 2, hasMore: false },
};
vi.mock('@/shared/api', () => ({ api: {
  projects: async () => ({ ok: true, json: async () => [structuredClone(project)] }),
  projectTaskmaster: async () => ({ ok: false }),
  sessionDetails: async () => ({ ok: false }),
} }));

const listeners = new Set<(event: ServerEvent) => void>();
const subscribe = (listener: (event: ServerEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); };
const navigate = vi.fn();
const isSessionProcessing = () => false;
const emit = (event: ServerEvent) => act(() => { for (const listener of listeners) listener(event); });
const upsert = (id: string, update: Partial<ProjectSession>) => ({
  kind: 'session_upserted', sessionId: id, provider: 'claude', session: { id, ...update }, project,
});
const setup = async () => {
  const hook = renderHook(() => useProjectsState({ sessionId: 'one', navigate, subscribe, isMobile: false, isSessionProcessing }));
  await waitFor(() => expect(hook.result.current.selectedSession?.id).toBe('one'));
  return hook;
};
const unread = (hook: Awaited<ReturnType<typeof setup>>, id: string) => hook.result.current.sidebarSharedProps.attentionSessionIds.has(id);

beforeEach(() => { localStorage.clear(); listeners.clear(); navigate.mockClear(); });
afterEach(() => vi.restoreAllMocks());

test('a hidden retained iframe does not read its selected session; revealing its host clears the unread marker', async () => {
  const host = document.createElement('div');
  const frame = document.createElement('iframe');
  host.append(frame); document.body.append(host); host.hidden = true;
  vi.spyOn(window, 'frameElement', 'get').mockReturnValue(frame);
  const hook = await setup();
  emit(upsert('one', { messageCount: 3 }));
  expect(unread(hook, 'one')).toBe(true);
  act(() => hook.result.current.handleSessionSelect({ id: 'one' }));
  expect(unread(hook, 'one')).toBe(true);
  await act(async () => { host.hidden = false; });
  await waitFor(() => expect(unread(hook, 'one')).toBe(false));
  hook.unmount(); host.remove();
});

test('browser visibility and the active chat tab control whether incoming messages have been read', async () => {
  let visibility: DocumentVisibilityState = 'hidden';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  const hook = await setup();
  emit({ kind: 'text', sessionId: 'one', text: 'fixture' });
  expect(unread(hook, 'one')).toBe(true);
  act(() => { visibility = 'visible'; document.dispatchEvent(new Event('visibilitychange')); });
  expect(unread(hook, 'one')).toBe(false);
  act(() => hook.result.current.setActiveTab('files'));
  emit(upsert('one', { messageCount: 3 }));
  expect(unread(hook, 'one')).toBe(true);
  act(() => hook.result.current.setActiveTab('chat'));
  expect(unread(hook, 'one')).toBe(false);
});

test('a workspace panel hiding the chat does not consume unread messages until chat is revealed', async () => {
  const chat = document.createElement('div');
  chat.dataset.testid = 'workspace-main-chat'; chat.className = 'hidden'; document.body.append(chat);
  const hook = await setup();
  emit({ kind: 'text', sessionId: 'one', text: 'fixture' });
  expect(unread(hook, 'one')).toBe(true);
  await act(async () => { chat.className = ''; });
  await waitFor(() => expect(unread(hook, 'one')).toBe(false));
  hook.unmount(); chat.remove();
});

test('renames and placeholder counts do not mark messages unread or reset their watermark', async () => {
  const hook = await setup();
  emit(upsert('two', { summary: 'Renamed', messageCount: 0, lastActivity: '2026-01-02T00:00:00Z' }));
  expect(unread(hook, 'two')).toBe(false);
  emit(upsert('two', { messageCount: 4, lastActivity: '2026-01-02T00:00:00Z' }));
  expect(unread(hook, 'two')).toBe(false);
  emit(upsert('two', { messageCount: 5 }));
  expect(unread(hook, 'two')).toBe(true);
});

test('a changed last-message observation marks unread without requiring the message count to increase', async () => {
  const hook = await setup();
  emit(upsert('two', { messageCount: 4, lastMessage: 'new response', lastActivity: '2026-01-02T00:00:00Z' }));
  expect(unread(hook, 'two')).toBe(true);
});

test('duplicate upserts after reading do not recreate unread state', async () => {
  const hook = await setup();
  const update = upsert('two', { messageCount: 5, lastMessage: 'new response', lastActivity: '2026-01-02T00:00:00Z' });
  emit(update);
  expect(unread(hook, 'two')).toBe(true);
  act(() => hook.result.current.handleSessionSelect({ id: 'two' }));
  expect(unread(hook, 'two')).toBe(false);
  emit(update); emit(update);
  expect(unread(hook, 'two')).toBe(false);
});

test('replayed completion metadata does not turn an already read completion unread', async () => {
  const hook = await setup();
  const completion = { kind: 'session_activity', sessionId: 'one', status: 'complete', eventId: 'execution-1:complete' };
  emit(completion);
  expect(unread(hook, 'one')).toBe(false);
  act(() => hook.result.current.setActiveTab('files'));
  emit(completion);
  expect(unread(hook, 'one')).toBe(false);
  emit({ ...completion, eventId: 'execution-2:complete' });
  expect(unread(hook, 'one')).toBe(true);
});
