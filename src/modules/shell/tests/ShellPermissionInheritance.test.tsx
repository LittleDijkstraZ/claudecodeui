import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getClaudeSettings } from '@/shared/userSettings';
import Shell from '@/modules/shell/Shell';
import { useShellRuntime } from '@/modules/shell/hooks/useShellRuntime';
import type { Project, ProjectSession } from '@/shared/types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/shared/userSettings', () => ({ getClaudeSettings: vi.fn() }));
vi.mock('@/modules/shell/hooks/useShellRuntime', () => ({ useShellRuntime: vi.fn(() => ({
  terminalContainerRef: { current: null }, terminalRef: { current: null }, wsRef: { current: null },
  isConnected: false, isInitialized: false, isConnecting: false, executionBinding: null,
  terminateShell: async () => false, connectToShell: vi.fn(), disconnectFromShell: vi.fn(),
})) }));

const project = { projectId: 'project-fixture', displayName: 'Fixture', name: 'project-fixture', path: '/remote/project', fullPath: '/remote/project' } as Project;
const session = { id: 'permission-fixture', __provider: 'claude' } as ProjectSession;

describe('native terminal permission inheritance', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(useShellRuntime).mockClear();
    vi.mocked(getClaudeSettings).mockReturnValue({ allowedTools: [], disallowedTools: [], skipPermissions: false, projectSortOrder: 'name' });
  });

  it('passes the saved session mode and exact rules without granting the whole directory', () => {
    localStorage.setItem('permissionMode-permission-fixture', 'acceptEdits');
    vi.mocked(getClaudeSettings).mockReturnValue({ allowedTools: ['Read(//tmp/turn_00.txt)'], disallowedTools: ['Bash(rm *)'], skipPermissions: false, projectSortOrder: 'name' });
    render(<Shell selectedProject={project} selectedSession={session} minimal />);
    expect(vi.mocked(useShellRuntime).mock.calls.at(-1)?.[0]).toMatchObject({
      bypassPermissions: false,
      permissionSelection: { permissionMode: 'acceptEdits', toolsSettings: { allowedTools: ['Read(//tmp/turn_00.txt)'], disallowedTools: ['Bash(rm *)'], skipPermissions: false } },
    });
  });

  it('does not turn a previous once-only approval into a saved rule or bypass mode', () => {
    render(<Shell selectedProject={project} selectedSession={session} minimal />);
    expect(vi.mocked(useShellRuntime).mock.calls.at(-1)?.[0]).toMatchObject({
      bypassPermissions: false,
      permissionSelection: { permissionMode: 'default', toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: false } },
    });
  });

  it('preserves explicit Plan mode over a broader saved permission default', () => {
    localStorage.setItem('permissionMode-permission-fixture', 'plan');
    vi.mocked(getClaudeSettings).mockReturnValue({ allowedTools: [], disallowedTools: [], skipPermissions: true, projectSortOrder: 'name' });
    render(<Shell selectedProject={project} selectedSession={session} minimal />);
    expect(vi.mocked(useShellRuntime).mock.calls.at(-1)?.[0]).toMatchObject({ bypassPermissions: false, permissionSelection: { permissionMode: 'plan' } });
  });
});
