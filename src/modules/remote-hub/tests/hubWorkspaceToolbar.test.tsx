import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { HubWorkspaceToolbar } from '@/modules/remote-hub/HubWorkspaceToolbar';

beforeEach(() => localStorage.clear());

describe('legacy remote tool navigation', () => {
  test('keeps accessible tool icons in the fallback drawer and excludes the permanent main chat', () => {
    const select = vi.fn();
    render(<HubWorkspaceToolbar onSelect={select} navigation={{ sessionId: 'session-a', activeTab: 'chat', tabs: [{ id: 'chat', label: 'Chat' }, { id: 'shell', label: 'Shell' }, { id: 'files', label: 'Files' }, { id: 'preferences', label: 'Preferences' }] }} />);
    expect(screen.queryByRole('button', { name: 'Chat' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Preferences' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Shell' }));
    expect(select).toHaveBeenCalledWith('shell');
    expect(screen.getByRole('tab', { name: 'Files' }).textContent).toBe('');
    expect(screen.getByRole('tab', { name: 'Files' }).title).toBe('Files');
  });
});
