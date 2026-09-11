import { useEffect } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ChatMessage, WorkspaceAgentsSnapshot } from '@/shared/types';
import { WorkspacePanelsProvider, useWorkspacePanelActions, useWorkspacePanels } from '@/modules/workspace-panels';
import { AgentSummary } from '@/modules/chat/agents/AgentSummary';
import { AgentsPanel } from '@/modules/chat/agents/AgentsPanel';
import { revealConversationChange } from '@/modules/chat/utils/revealConversationChange';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key }) }));
vi.mock('@/shared/ui', () => ({ Button: ({ variant: _variant, size: _size, ...props }: Record<string, unknown>) => <button {...props} /> }));
vi.mock('@/modules/chat/tools/ToolRenderer', () => ({ ToolRenderer: ({ toolId }: { toolId: string }) => <p>Tool {toolId}</p> }));
vi.mock('@/modules/chat/tools/ContentRenderers/MarkdownContent', () => ({ MarkdownContent: ({ content }: { content: string }) => <p>{content}</p> }));
vi.mock('@/modules/chat/utils/revealConversationChange', () => ({ revealConversationChange: vi.fn(() => () => {}) }));
const message = { id: 'agent-one', type: 'assistant', timestamp: '2026-09-07T01:00:00Z', content: '', isSubagentContainer: true, toolInput: { prompt: 'Research all 40 files' }, toolResult: { content: 'Agent final result' }, subagent: { id: 'child', name: 'Researcher', description: 'Inspect files', status: 'completed' }, subagentActivity: Array.from({ length: 40 }, (_, index) => ({ kind: 'tool', toolId: `tool-${index}`, toolName: 'Read', toolInput: {} })) } as ChatMessage;
const origin = vi.fn();
const snapshot = { sessionId: 'main', project: null, messages: [message], hasEarlierMessages: false, isLoadingEarlierMessages: false, loadEarlierMessages: () => {}, revealOrigin: origin } as WorkspaceAgentsSnapshot;
function Harness() {
  const actions = useWorkspacePanelActions(); const panel = useWorkspacePanels();
  useEffect(() => actions?.publishAgents(snapshot), [actions]);
  return <><div data-testid="agent-transcript-summary"><AgentSummary message={message} /></div><button onClick={() => actions?.openAgent('message-assistant-agent-one', 'tool-32')}>Reveal agent edit</button><output>{panel?.open ? panel.tab : 'closed'}</output><AgentsPanel /></>;
}
describe('agent workspace details', () => {
  it('opens a compact transcript agent into its full timeline and expands the exact changed tool beyond the first page', () => {
    render(<WorkspacePanelsProvider><Harness /></WorkspacePanelsProvider>);
    fireEvent.click(within(screen.getByTestId('agent-transcript-summary')).getByRole('button', { name: /Researcher.*Inspect files/ })); expect(screen.getByRole('status').textContent).toBe('agents');
    expect(screen.getByText('Research all 40 files')).toBeDefined(); expect(screen.getByText('Agent final result')).toBeDefined(); expect(screen.getByText('Duration not recorded')).toBeDefined();
    expect(screen.queryByText('Tool tool-32')).toBeNull(); fireEvent.click(screen.getByText('Reveal agent edit')); expect(screen.getByText('Tool tool-32')).toBeDefined(); expect(screen.queryByText('Tool tool-33')).toBeNull();
    expect(revealConversationChange).toHaveBeenLastCalledWith(expect.any(HTMLElement), expect.objectContaining({ messageKey: 'message-assistant-agent-one', toolId: 'tool-32' }), expect.any(Function));
    fireEvent.click(screen.getByText('Go to originating message')); expect(origin).toHaveBeenCalledWith('message-assistant-agent-one');
  });
});
