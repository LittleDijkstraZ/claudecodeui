import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import type { ChatMessage, WorkspaceAgentsSnapshot } from '@/shared/types';
import { WorkspacePanelsProvider, useWorkspacePanelActions } from '@/modules/workspace-panels';
import { AgentSummary } from '@/modules/chat/agents/AgentSummary';
import { AgentsPanel } from '@/modules/chat/agents/AgentsPanel';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string; count?: number }) => (options?.defaultValue ?? key).replace('{{count}}', String(options?.count)), i18n: { language: 'en' } }) }));
vi.mock('@/shared/ui', () => ({ Button: ({ variant: _variant, size: _size, ...props }: Record<string, unknown>) => <button {...props} /> }));
vi.mock('@/modules/chat/tools/ContentRenderers/MarkdownContent', () => ({ MarkdownContent: ({ content }: { content: string }) => <p>{content}</p> }));
vi.mock('@/modules/chat/tools/SubagentPanel', () => ({ SubagentPanel: () => null }));
vi.mock('@/modules/chat/utils/revealConversationChange', () => ({ revealConversationChange: () => () => {} }));

const message: ChatMessage = {
  id: 'workflow-message', type: 'assistant', isToolUse: true, toolId: 'workflow-tool', toolName: 'Workflow', executionId: 'current-run', timestamp: '2026-09-08T00:00:00Z',
  toolInput: { scriptPath: '/project/check.js', prompt: 'Check all packages', script: 'export async function run() {}' },
  toolResult: { content: 'Launched', toolUseResult: { workflowName: 'Quality check', status: 'async_launched', taskId: 'workflow-task' } },
};
function snapshot(overrides: Partial<WorkspaceAgentsSnapshot> = {}): WorkspaceAgentsSnapshot {
  return {
    sessionId: 'session', project: null, messages: [message], hasEarlierMessages: false, isLoadingEarlierMessages: false, loadEarlierMessages: vi.fn(), revealOrigin: vi.fn(), stopTask: vi.fn(),
    activity: { startedAt: 1, statusText: null, canInterrupt: true, canStopTask: true, phase: 'background', executionId: 'current-run' },
    records: [{ id: 'progress', sessionId: 'session', provider: 'claude', kind: 'status', workflow: true, taskId: 'workflow-task', toolUseId: 'workflow-tool', executionId: 'current-run', status: 'running', timestamp: '2026-09-08T00:00:10Z', text: 'Inspecting packages', usage: { total_tokens: 1200, tool_uses: 4, duration_ms: 2500 }, workflowProgress: [
      { type: 'workflow_phase', index: 0, title: 'Package review' },
      { type: 'workflow_agent', index: 1, phaseIndex: 0, label: 'Security reviewer', state: 'progress', model: 'claude-opus-4-6', promptPreview: 'Review dependency changes', lastToolName: 'Read', lastToolSummary: 'package.json', resultPreview: 'No concerns found', toolCalls: 4 },
    ] }], ...overrides,
  };
}
function PublishedPanel({ value }: { value: WorkspaceAgentsSnapshot }) {
  const actions = useWorkspacePanelActions();
  useEffect(() => { actions?.publishAgents(value); }, [actions, value]);
  return <><div data-testid="transcript-summary"><AgentSummary message={message} /></div><AgentsPanel /></>;
}
function panel(value: WorkspaceAgentsSnapshot) { return <WorkspacePanelsProvider><PublishedPanel value={value} /></WorkspacePanelsProvider>; }

afterEach(cleanup);

describe('workflow inspection and native task control', () => {
  it('opens a workflow summary into phase and agent previews, launch input, activity and usage', () => {
    render(panel(snapshot()));
    fireEvent.click(within(screen.getByTestId('transcript-summary')).getByRole('button', { name: /Quality check/ }));
    expect(screen.getByRole('heading', { name: 'Quality check' })).toBeDefined();
    const details = screen.getByTestId('workflow-details');
    expect(within(details).getByText('Check all packages')).toBeDefined();
    expect(within(details).getByText('1,200')).toBeDefined();
    expect(within(details).getByText('2.5s')).toBeDefined();
    const agent = within(details).getByText('Security reviewer').closest('details')!;
    expect(agent.open).toBe(false);
    fireEvent.click(within(agent).getByText('Security reviewer'));
    expect(agent.open).toBe(true);
    expect(within(agent).getByText('Review dependency changes')).toBeDefined();
    expect(within(agent).getByText('No concerns found')).toBeDefined();
    const activity = within(details).getByRole('region', { name: 'Recorded activity' });
    expect(within(activity).getByText('Inspecting packages')).toBeDefined();
  });

  it('targets the exact live task and keeps the native status unchanged while stopping', () => {
    const initial = snapshot();
    const view = render(panel(initial));
    fireEvent.click(screen.getByRole('button', { name: 'Stop this task' }));
    expect(initial.stopTask).toHaveBeenCalledWith('workflow-task');
    view.rerender(panel({ ...initial, stoppingTaskId: 'workflow-task' }));
    expect((screen.getByRole('button', { name: 'Stopping…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText('stopped')).toBeNull();
    view.rerender(panel({ ...initial, taskStopError: 'The task is no longer active.' }));
    expect(screen.getByRole('alert').textContent).toBe('The task is no longer active.');
  });

  it('starts with recent activity and expands the earlier recorded updates on demand', () => {
    const initial = snapshot();
    const records = Array.from({ length: 35 }, (_, index) => ({ ...initial.records![0], id: `update-${index}`, timestamp: new Date(Date.UTC(2026, 8, 8, 0, 0, index)).toISOString(), text: `Update ${index}`, workflowProgress: undefined }));
    render(panel({ ...initial, records }));
    const activity = screen.getByRole('region', { name: 'Recorded activity' });
    expect(within(activity).getAllByRole('listitem')).toHaveLength(30);
    expect(within(activity).queryByText('Update 0')).toBeNull();
    fireEvent.click(within(activity).getByRole('button', { name: 'Show 5 earlier updates' }));
    expect(within(activity).getAllByRole('listitem')).toHaveLength(35);
    expect(within(activity).getByText('Update 0')).toBeDefined();
  });

  it('offers no stop action for stale activity, unavailable capability, or a completed task', () => {
    const initial = snapshot();
    const view = render(panel({ ...initial, activity: null }));
    expect(screen.queryByRole('button', { name: 'Stop this task' })).toBeNull();
    view.rerender(panel({ ...initial, activity: { ...initial.activity!, canStopTask: false } }));
    expect(screen.queryByRole('button', { name: 'Stop this task' })).toBeNull();
    view.rerender(panel({ ...initial, records: [...initial.records!, { ...initial.records![0], id: 'done', kind: 'task_notification', status: 'completed', timestamp: '2026-09-08T00:00:20Z', content: 'Checks passed' }] }));
    expect(screen.queryByRole('button', { name: 'Stop this task' })).toBeNull();
    expect(screen.getByText('Checks passed')).toBeDefined();
  });
});
