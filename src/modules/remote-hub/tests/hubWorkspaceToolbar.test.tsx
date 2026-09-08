import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { HubWorkspaceToolbar } from '@/modules/remote-hub/HubWorkspaceToolbar';

describe('legacy remote tool navigation', () => {
  test('keeps named tools outside preferences and excludes the permanent main chat', () => {
    const select = vi.fn();
    const settings = vi.fn();
    render(<HubWorkspaceToolbar machine="Alpha" title="Experiment" sidebarClosed={false} onSelect={select} onSettings={settings} navigation={{ sessionId: 'session-a', activeTab: 'chat', tabs: [{ id: 'chat', label: 'Chat' }, { id: 'shell', label: 'Shell' }, { id: 'files', label: 'Files' }, { id: 'preferences', label: 'Preferences' }] }} />);
    expect(screen.queryByRole('button', { name: 'Chat' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Preferences' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Shell' }));
    expect(select).toHaveBeenCalledWith('shell');
    expect(screen.getByRole('tab', { name: 'Files' }).textContent).toContain('Files');
    fireEvent.click(screen.getByRole('button', { name: 'Alpha 的设置' }));
    expect(settings).toHaveBeenCalledOnce();
  });
});
