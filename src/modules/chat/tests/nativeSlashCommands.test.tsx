import { act, renderHook, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';

import { useSlashCommands } from '@/modules/chat/hooks/useSlashCommands';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import type { LLMProvider, Project } from '@/shared/types';
import { resetChatDrafts } from '@/shared/chatDrafts';

const { list, skills, execute, createSession } = vi.hoisted(() => ({ list: vi.fn(), skills: vi.fn(), execute: vi.fn(), createSession: vi.fn() }));
vi.mock('@/shared/api', () => ({ api: {
  getFiles: async () => ({ ok: true, json: async () => [] }),
  commands: { list, execute }, providers: { skills, createSession }, files: { search: async () => ({ ok: true, json: async () => ({ files: [] }) }) },
  user: { drafts: async () => ({ ok: true, json: async () => ({ drafts: [] }) }), saveDraft: async () => ({ ok: true }), deleteDraft: async () => ({ ok: true }) },
} }));
const PROJECT: Project = { projectId: 'remote-project', fullPath: '/remote/project', displayName: 'Remote project' };
const response = (value: unknown) => ({ ok: true, json: async () => value });
const COMPACT = { name: '/compact', type: 'native', namespace: 'native', metadata: { availability: 'documented' }, description: 'Compact real context' };
const CATALOG = { native: [COMPACT], builtIn: [{ name: '/help', namespace: 'builtin' }], custom: [] };
beforeEach(() => {
  localStorage.clear(); resetChatDrafts(); vi.clearAllMocks();
  list.mockImplementation(async () => response(CATALOG)); skills.mockImplementation(async () => response({ data: { skills: [] } }));
});
function menu(sessionId = 'session-a', provider: LLMProvider = 'claude') {
  const onExecute = vi.fn();
  return { onExecute, ...renderHook(({ sessionId, provider }: { sessionId: string; provider: LLMProvider }) => {
    const [input, setInput] = useState('');
    const commands = useSlashCommands({ selectedProject: PROJECT, sessionId, provider, input, setInput, textareaRef: useRef<HTMLTextAreaElement>(null), onExecuteCommand: onExecute });
    return { ...commands, input };
  }, { initialProps: { sessionId, provider } }) };
}

test('native menu choices insert the command for normal submission; existing UI help still executes in CloudCLI', async () => {
  const view = menu();
  await waitFor(() => expect(view.result.current.slashCommands).toHaveLength(2));
  act(() => view.result.current.handleCommandSelect(view.result.current.slashCommands.find(command => command.name === '/compact')!, 1, false));
  expect(view.result.current.input).toBe('/compact '); expect(view.onExecute).not.toHaveBeenCalled();
  act(() => view.result.current.handleCommandSelect(view.result.current.slashCommands.find(command => command.name === '/help')!, 0, false));
  expect(view.onExecute).toHaveBeenCalledWith(expect.objectContaining({ name: '/help' }));
});

test('native discovery follows the selected remote session and refreshes only on its command-metadata notification', async () => {
  const view = menu();
  await waitFor(() => expect(view.result.current.slashCommands).toHaveLength(2));
  expect(list).toHaveBeenLastCalledWith('/remote/project', 'claude', 'session-a');
  const calls = list.mock.calls.length;
  act(() => window.dispatchEvent(new CustomEvent('cloudcli-native-commands-changed', { detail: { sessionId: 'session-b' } })));
  expect(list).toHaveBeenCalledTimes(calls);
  list.mockResolvedValueOnce(response({ ...CATALOG, native: [{ ...COMPACT, name: '/context' }] }));
  act(() => window.dispatchEvent(new CustomEvent('cloudcli-native-commands-changed', { detail: { sessionId: 'session-a' } })));
  await waitFor(() => expect(view.result.current.slashCommands.some(command => command.name === '/context')).toBe(true));
  view.rerender({ sessionId: 'session-b', provider: 'codex' });
  await waitFor(() => expect(list).toHaveBeenLastCalledWith('/remote/project', 'codex', 'session-b'));
  await waitFor(() => expect(view.result.current.slashCommands.every(command => command.type !== 'native')).toBe(true));
  expect(execute).not.toHaveBeenCalled(); expect(createSession).not.toHaveBeenCalled();
});

test('a skills-list failure cannot hide the documented native command surface', async () => {
  skills.mockRejectedValueOnce(new Error('Skills unavailable'));
  const view = menu();
  await waitFor(() => expect(view.result.current.slashCommands.some(command => command.name === '/compact')).toBe(true));
});

function composer(sessionId: string | null = 'session-a') {
  const send = vi.fn(() => true); const add = vi.fn();
  const view = renderHook(() => useChatComposerState({
    selectedProject: PROJECT, selectedSession: sessionId ? { id: sessionId } : null, currentSessionId: sessionId, provider: 'claude',
    permissionMode: 'default', cyclePermissionMode() {}, resolvePermissionModeForProvider: () => 'default',
    currentProviderModel: 'default', currentProviderEffort: 'default', isLoading: false,
    processingSessions: new Map(sessionId ? [[sessionId, { startedAt: 1, statusText: null, canInterrupt: true, acceptsInput: true, phase: 'background' }]] : []),
    canAbortSession: true, tokenBudget: null, sendMessage: send, scrollToBottom() {}, addMessage: add, setIsUserScrolledUp() {}, setPendingPermissionRequests() {},
  }));
  return { ...view, send, add };
}

test('typed compact with focus instructions uses the same conversation send path and client receipt UUID', async () => {
  const view = composer();
  await waitFor(() => expect(view.result.current.slashCommandsCount).toBe(2));
  await act(async () => view.result.current.setInput('/compact keep methods and uncertainty'));
  await act(async () => view.result.current.handleSubmit({ preventDefault() {} } as never));
  expect(view.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.send', sessionId: 'session-a', content: '/compact keep methods and uncertainty', clientMessageId: expect.stringMatching(/^[0-9a-f-]{36}$/) }));
  expect(execute).not.toHaveBeenCalled(); expect(createSession).not.toHaveBeenCalled();
});

test('compact on a blank conversation keeps the draft and explains that history is needed without allocating a session', async () => {
  const view = composer(null);
  await act(async () => view.result.current.setInput('/compact'));
  await act(async () => view.result.current.handleSubmit({ preventDefault() {} } as never));
  expect(view.send).not.toHaveBeenCalled(); expect(createSession).not.toHaveBeenCalled();
  expect(view.result.current.input).toBe('/compact');
  expect(view.add).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', content: expect.stringMatching(/prior messages/) }));
});
