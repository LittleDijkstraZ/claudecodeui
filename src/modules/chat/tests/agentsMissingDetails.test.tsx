import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { ChatMessage, WorkspaceAgentsSnapshot } from '@/shared/types';
import { WorkspacePanelsProvider, useWorkspacePanelActions } from '@/modules/workspace-panels';
import { AgentsPanel } from '@/modules/chat/agents/AgentsPanel';

vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string, options?: { defaultValue?: string; count?: number }) => (options?.defaultValue ?? key).replace('{{count}}', String(options?.count)),
}) }));
vi.mock('@/shared/ui', () => ({ Button: ({ variant: _variant, size: _size, ...props }: Record<string, unknown>) => <button {...props} /> }));
vi.mock('@/modules/chat/tools/SubagentPanel', () => ({ SubagentPanel: () => null }));

function PublishedPanel({ snapshot }: { snapshot: WorkspaceAgentsSnapshot }) {
  const actions = useWorkspacePanelActions();
  useEffect(() => {
    actions?.publishAgents(snapshot);
    actions?.openPanel('agents');
  }, [actions, snapshot]);
  return <AgentsPanel />;
}
function panel(snapshot: WorkspaceAgentsSnapshot) {
  return <WorkspacePanelsProvider><PublishedPanel snapshot={snapshot} /></WorkspacePanelsProvider>;
}
function snapshot(overrides: Partial<WorkspaceAgentsSnapshot> = {}): WorkspaceAgentsSnapshot {
  return {
    sessionId: 'synthetic-session', project: null, messages: [], records: [],
    activity: { startedAt: 1, statusText: null, canInterrupt: true, phase: 'background', backgroundTasks: 1, executionId: 'synthetic-execution' },
    hasEarlierMessages: true, isLoadingEarlierMessages: false,
    loadEarlierMessages: vi.fn(), revealOrigin: vi.fn(), ...overrides,
  };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('reported background tasks without loaded details', () => {
  it.each([null, 0])('keeps the ordinary empty view when the reported background count is %s', (count) => {
    render(panel(snapshot({ activity: count === null ? null : { ...snapshot().activity!, backgroundTasks: count } })));
    expect(screen.queryByTestId('unloaded-task-details')).toBeNull();
    expect(screen.getByText('Agents and Workflows from this conversation appear here with their recorded progress and results.')).toBeDefined();
    expect(screen.getAllByRole('button', { name: 'Load earlier conversation activity' })).toHaveLength(1);
  });

  it('shows the remote count and one explicit read-only load action without automatically fetching or controlling work', () => {
    const loadEarlierMessages = vi.fn();
    const network = vi.fn();
    const sockets = vi.fn();
    vi.stubGlobal('fetch', network);
    vi.stubGlobal('WebSocket', sockets);
    render(panel(snapshot({ loadEarlierMessages, activity: { startedAt: 1, statusText: null, canInterrupt: false, phase: 'background', backgroundTasks: 2 } })));
    expect(screen.getByRole('status').textContent).toBe('The remote reports 2 background tasks.');
    expect(screen.getByText(/Task details have not been loaded yet/)).toBeDefined();
    expect(screen.getByText('Loads one earlier page of saved records. It does not resume or stop tasks.')).toBeDefined();
    const buttons = screen.getAllByRole('button', { name: 'Load earlier conversation activity' });
    expect(buttons).toHaveLength(1);
    expect(loadEarlierMessages).not.toHaveBeenCalled();
    fireEvent.click(buttons[0]);
    expect(loadEarlierMessages).toHaveBeenCalledTimes(1);
    expect(network).not.toHaveBeenCalled();
    expect(sockets).not.toHaveBeenCalled();
  });

  it('explains missing records without promising that another page can provide them', () => {
    render(panel(snapshot({ hasEarlierMessages: false })));
    expect(screen.getByText('The available conversation records do not provide task details.')).toBeDefined();
    expect(screen.queryByRole('button', { name: /Load earlier/ })).toBeNull();
    expect(screen.queryByText(/Task details have not been loaded yet/)).toBeNull();
  });

  it('disables the prominent loading action and retains the fetch error', () => {
    const loadEarlierMessages = vi.fn();
    render(panel(snapshot({ isLoadingEarlierMessages: true, loadEarlierMessages, historyError: 'Synthetic history fetch failed' })));
    const button = screen.getByRole('button', { name: 'Loading earlier activity…' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(loadEarlierMessages).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('Synthetic history fetch failed');
  });

  it('replaces the placeholder with the recorded Workflow when an earlier page arrives', () => {
    const initial = snapshot();
    const view = render(panel(initial));
    expect(screen.getByTestId('unloaded-task-details')).toBeDefined();
    const workflow = {
      id: 'workflow-call', type: 'assistant', content: '', timestamp: '2026-09-08T00:00:00Z',
      isToolUse: true, toolId: 'workflow-tool', toolName: 'Workflow', executionId: 'synthetic-execution',
      toolInput: { description: 'Recorded synthetic Workflow', scriptPath: '/synthetic/workflow.js' },
      toolResult: { content: 'Saved result', toolUseResult: { taskId: 'synthetic-task', status: 'completed' } },
    } as ChatMessage;
    view.rerender(panel({ ...initial, messages: [workflow] }));
    expect(screen.queryByTestId('unloaded-task-details')).toBeNull();
    expect(screen.getAllByText('Recorded synthetic Workflow').length).toBeGreaterThan(0);
    expect(screen.getByText('Saved result')).toBeDefined();
    expect(screen.getAllByRole('button', { name: 'Load earlier conversation activity' })).toHaveLength(1);
  });
});
