import { useEffect } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project, ProjectSession } from '@/shared/types';
import WorkspaceTerminals from '@/modules/project-workspace/WorkspaceTerminals';

const events = vi.hoisted(() => ({ mounted: vi.fn(), unmounted: vi.fn(), terminated: vi.fn(), canTerminate: true, pendingTermination: null as Promise<boolean> | null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key }) }));
vi.mock('@/shared/ui', () => ({ Button: ({ variant: _variant, size: _size, ...props }: Record<string, unknown>) => <button {...props} /> }));
vi.mock('@/modules/standalone-shell', () => ({ StandaloneShell: ({ terminalInstanceId, project, session, isPlainShell, isActive, onTerminateReady }: { terminalInstanceId: string; project: Project; session: ProjectSession | null; isPlainShell: boolean; isActive: boolean; onTerminateReady: (terminate: (() => Promise<boolean>) | null) => void }) => {
  useEffect(() => { events.mounted(terminalInstanceId); return () => events.unmounted(terminalInstanceId); }, [terminalInstanceId]);
  useEffect(() => { onTerminateReady(async () => { if (!events.canTerminate) return false; events.terminated(terminalInstanceId); return events.pendingTermination ?? true; }); return () => onTerminateReady(null); }, [onTerminateReady, terminalInstanceId]);
  return <output data-testid="terminal" data-instance={terminalInstanceId} data-project={project.projectId} data-session={session?.id ?? ''} data-plain={isPlainShell} data-active={isActive} />;
} }));
const projectA = { projectId: 'project-a', displayName: 'A', path: '/remote/a' } as Project;
const projectB = { projectId: 'project-b', displayName: 'B', path: '/remote/b' } as Project;
const sessionA = { id: 'session-a', __provider: 'claude', sessionName: 'A chat' } as ProjectSession;
const sessionB = { id: 'session-b', __provider: 'claude', sessionName: 'B chat' } as ProjectSession;
beforeEach(() => { vi.clearAllMocks(); window.__REMOTE_NAME__ = 'Server Alpha'; events.canTerminate = true; events.pendingTermination = null; });

describe('remote terminal lifetime', () => {
  it('freezes machine/project/session bindings across conversation navigation and keeps hidden PTYs mounted', async () => {
    const { rerender } = render(<WorkspaceTerminals project={projectA} session={sessionA} visible />);
    const first = screen.getAllByTestId('terminal')[0]; const firstId = first.dataset.instance;
    expect(first.dataset.project).toBe('project-a'); expect(first.dataset.plain).toBe('true'); expect(first.dataset.session).toBe('');
    rerender(<WorkspaceTerminals project={projectB} session={sessionB} visible={false} />);
    expect(screen.getAllByTestId('terminal')[0]).toBe(first); expect(first.dataset.project).toBe('project-a'); expect(events.unmounted).not.toHaveBeenCalled();
    rerender(<WorkspaceTerminals project={projectB} session={sessionB} visible />);
    fireEvent.click(screen.getByText('New terminal')); const plainB = screen.getAllByTestId('terminal')[1]; expect(plainB.dataset.instance).not.toBe(firstId); expect(plainB.dataset.project).toBe('project-b');
    fireEvent.click(screen.getByText('Open this Claude session in terminal')); fireEvent.click(screen.getByText('Open this Claude session in terminal'));
    expect(screen.getAllByTestId('terminal')).toHaveLength(3); const agent = screen.getAllByTestId('terminal')[2]; expect(agent.dataset.session).toBe('session-b'); expect(agent.dataset.plain).toBe('false');
    rerender(<WorkspaceTerminals project={projectA} session={sessionA} visible />); expect(agent.dataset.session).toBe('session-b');
    expect(events.mounted).toHaveBeenCalledTimes(3); expect(events.unmounted).not.toHaveBeenCalled();
    events.canTerminate = false; await act(async () => fireEvent.click(screen.getByLabelText('Close this terminal and stop its process'))); expect(screen.getAllByTestId('terminal')).toHaveLength(3); expect(screen.getByRole('alert').textContent).toContain('Reconnect'); events.canTerminate = true;
    let resolveTermination!: (value: boolean) => void; events.pendingTermination = new Promise<boolean>(resolve => { resolveTermination = resolve; });
    fireEvent.click(screen.getByLabelText('Close this terminal and stop its process')); fireEvent.click(screen.getByLabelText('Close this terminal and stop its process')); expect(events.terminated).toHaveBeenCalledTimes(1); expect(events.terminated).toHaveBeenCalledWith(agent.dataset.instance); expect(events.unmounted).not.toHaveBeenCalled(); expect(screen.getAllByTestId('terminal')).toHaveLength(3);
    await act(async () => resolveTermination(true)); expect(events.unmounted).toHaveBeenCalledWith(agent.dataset.instance); expect(screen.getAllByTestId('terminal')).toHaveLength(2);
  });
});
