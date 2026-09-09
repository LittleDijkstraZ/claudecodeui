import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { BtwPanels, WorkspacePanelsProvider, useWorkspacePanelActions, useWorkspacePanels } from '@/modules/workspace-panels';
import WorkspaceTabs from '@/modules/project-workspace/WorkspaceTabs';
import { askClaudeBtw } from '@/shared/api';
import type { ProjectSession } from '@/shared/types';

vi.mock('@/shared/api', () => ({ askClaudeBtw: vi.fn() }));
vi.mock('@/modules/plugins', () => ({ usePlugins: () => ({ plugins: [] }), PluginIcon: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: { title?: string }) => options?.title ? `${key} ${options.title}` : key }) }));
function Harness({ sessionId = 'source-a' }: { sessionId?: string }) {
  const panel = useWorkspacePanels(); const actions = useWorkspacePanelActions();
  return <><output data-testid="open">{String(panel?.open)}</output>
    <button onClick={() => actions?.collapsePanel()}>collapse</button>
    <WorkspaceTabs activeTab={panel?.tab ?? 'shell'} sessionId={sessionId} session={{ id: sessionId, __provider: 'claude', summary: sessionId } as ProjectSession}
      setActiveTab={tab => { if (tab !== 'chat') actions?.togglePanel(tab); }} shouldShowTasksTab={false} shouldShowBrowserTab={false} />
    <BtwPanels />
  </>;
}
function add() { fireEvent.click(screen.getByRole('button', { name: 'btw.addTab' })); fireEvent.click(screen.getByRole('menuitem', { name: 'btw.new' })); }

describe('ephemeral BTW tabs', () => {
  it('adds and selects tabs, retains drafts, confirms removal, and never toggles tabs closed', () => {
    render(<WorkspacePanelsProvider><Harness /></WorkspacePanelsProvider>);
    fireEvent.click(screen.getByRole('tab', { name: 'tabs.shell' }));
    fireEvent.click(screen.getByRole('tab', { name: 'tabs.shell' }));
    expect(screen.getByTestId('open').textContent).toBe('true');
    add(); fireEvent.change(screen.getByRole('textbox'), { target: { value: 'keep this draft' } });
    add(); expect(screen.getByRole('tab', { name: 'BTW 2' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'BTW 1' }));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('keep this draft');
    fireEvent.click(screen.getByRole('button', { name: 'btw.closeTab BTW 1' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'btw.cancel' }));
    expect(screen.getByRole('tab', { name: 'BTW 1' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'btw.closeTab BTW 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'btw.confirmClose' }));
    expect(screen.queryByRole('tab', { name: 'BTW 1' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'BTW 2' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('open').textContent).toBe('true');
  });
  it('binds requests to the original conversation and aborts only a closed tab', async () => {
    let requestSignal: AbortSignal | undefined;
    let complete: ((value: { answer: string }) => void) | undefined;
    vi.mocked(askClaudeBtw).mockImplementation((_session, _question, signal) => { requestSignal = signal; return new Promise(resolve => { complete = resolve; }); });
    const view = render(<WorkspacePanelsProvider><Harness /></WorkspacePanelsProvider>);
    add();
    view.rerender(<WorkspacePanelsProvider><Harness sessionId="source-b" /></WorkspacePanelsProvider>);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'What changed?' } });
    fireEvent.click(screen.getByRole('button', { name: 'btw.send' }));
    expect(askClaudeBtw).toHaveBeenLastCalledWith('source-a', 'What changed?', expect.any(AbortSignal), []);
    fireEvent.click(screen.getByRole('tab', { name: 'tabs.shell' }));
    expect(requestSignal?.aborted).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'btw.closeTab BTW · What changed?' }));
    fireEvent.click(screen.getByRole('button', { name: 'btw.confirmClose' }));
    expect(requestSignal?.aborted).toBe(true);
    await act(async () => complete?.({ answer: 'late answer' }));
    expect(screen.queryByText('late answer')).toBeNull();
  });
  it('renders the native answer and discards it on close', async () => {
    vi.mocked(askClaudeBtw).mockResolvedValue({ answer: '**Side answer**' });
    render(<WorkspacePanelsProvider><Harness /></WorkspacePanelsProvider>);
    add(); fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Explain' } });
    fireEvent.click(screen.getByRole('button', { name: 'btw.send' }));
    await waitFor(() => expect(screen.getByText('Side answer')).toBeTruthy());
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'btw.closeTab BTW · Explain' }));
    fireEvent.click(screen.getByRole('button', { name: 'btw.confirmClose' }));
    expect(screen.queryByText('Side answer')).toBeNull();
  });
  it('clears on Enter, keeps the next draft during a request, and sends prior exchanges on follow-ups', async () => {
    vi.mocked(askClaudeBtw).mockClear();
    let complete: ((value: { answer: string }) => void) | undefined;
    vi.mocked(askClaudeBtw).mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    render(<WorkspacePanelsProvider><Harness /></WorkspacePanelsProvider>);
    add();
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'First question' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(askClaudeBtw).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(askClaudeBtw).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(askClaudeBtw).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('');
    fireEvent.change(input, { target: { value: 'Follow-up' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(askClaudeBtw).toHaveBeenCalledTimes(1);
    await act(async () => complete?.({ answer: 'First answer' }));
    expect(input.value).toBe('Follow-up');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('');
    expect(askClaudeBtw).toHaveBeenLastCalledWith('source-a', 'Follow-up', expect.any(AbortSignal), [{ question: 'First question', response: 'First answer' }]);
    await act(async () => complete?.({ answer: 'Second answer' }));
    expect(screen.getByText('First answer')).toBeTruthy();
    expect(screen.getByText('Second answer')).toBeTruthy();
    fireEvent.change(input, { target: { value: 'Third question' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(askClaudeBtw).toHaveBeenLastCalledWith('source-a', 'Third question', expect.any(AbortSignal), [
      { question: 'First question', response: 'First answer' }, { question: 'Follow-up', response: 'Second answer' },
    ]);
    await act(async () => complete?.({ answer: 'Third answer' }));
    expect(screen.getByRole('tab', { name: 'BTW · First question' })).toBeTruthy();
    add();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Independent question' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(askClaudeBtw).toHaveBeenLastCalledWith('source-a', 'Independent question', expect.any(AbortSignal), []);
    await act(async () => complete?.({ answer: 'Independent answer' }));
  });
  it('retries a failed follow-up without duplicating turns or including errors in history', async () => {
    vi.mocked(askClaudeBtw).mockResolvedValueOnce({ answer: 'First answer' }).mockRejectedValueOnce(new Error('Network error')).mockResolvedValueOnce({ answer: 'Recovered answer' });
    render(<WorkspacePanelsProvider><Harness /></WorkspacePanelsProvider>);
    add();
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'First' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await screen.findByText('First answer');
    fireEvent.change(input, { target: { value: 'Second' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await screen.findByRole('alert');
    fireEvent.change(input, { target: { value: 'Keep next draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'btw.retry' }));
    await screen.findByText('Recovered answer');
    expect(screen.getAllByText('Second')).toHaveLength(1);
    expect((input as HTMLTextAreaElement).value).toBe('Keep next draft');
    expect(askClaudeBtw).toHaveBeenLastCalledWith('source-a', 'Second', expect.any(AbortSignal), [{ question: 'First', response: 'First answer' }]);
  });
  it('bounds long follow-up context while preserving the full visible answer', async () => {
    const answer = 'a'.repeat(65000);
    vi.mocked(askClaudeBtw).mockResolvedValueOnce({ answer }).mockResolvedValueOnce({ answer: 'Follow-up answer' });
    render(<WorkspacePanelsProvider><Harness /></WorkspacePanelsProvider>);
    add();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Long answer please' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await screen.findByText('btw.contextLimited');
    expect(screen.getByText(answer)).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Follow-up' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await screen.findByText('Follow-up answer');
    const history = vi.mocked(askClaudeBtw).mock.lastCall?.[3];
    expect(history).toHaveLength(1);
    expect((history?.[0].question.length ?? 0) + (history?.[0].response.length ?? 0)).toBe(64000);
  });

});
