import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import Settings from '@/modules/settings/Settings';
import type { AgentSettingsProject } from '@/shared/types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key }) }));
vi.mock('@/modules/settings/hooks/useSettingsController', () => ({ useSettingsController: ({ initialTab }: { initialTab: string }) => {
  const [activeTab, setActiveTab] = useState(initialTab);
  return { activeTab, setActiveTab, providerAuthStatus: {}, loginProvider: null, showLoginModal: false };
} }));
vi.mock('@/modules/settings/hooks/useWebPush', () => ({ useWebPush: () => ({ permission: 'unsupported', isSubscribed: false, isLoading: false }) }));
vi.mock('@/modules/provider-auth', () => ({ ProviderLoginModal: () => null }));
vi.mock('@/modules/settings/tabs/agents-settings/AgentsSettingsTab', () => ({ default: ({ projects }: { projects: AgentSettingsProject[] }) => <div data-testid="agents-panel">{projects.map(project => project.fullPath).join(',')}</div> }));
vi.mock('@/modules/settings/tabs/AppearanceSettingsTab', () => ({ default: () => <div data-testid="appearance-panel" /> }));
vi.mock('@/modules/settings/tabs/api-settings/CredentialsSettingsTab', () => ({ default: () => <div data-testid="api-panel" /> }));
vi.mock('@/modules/settings/tabs/VoiceSettingsTab', () => ({ default: () => <div data-testid="voice-panel" /> }));
vi.mock('@/modules/settings/tabs/git-settings/GitSettingsTab', () => ({ default: () => <div data-testid="git-panel" /> }));
vi.mock('@/modules/settings/tabs/browser-use-settings/BrowserUseSettingsTab', () => ({ default: () => <div data-testid="browser-panel" /> }));
vi.mock('@/modules/settings/tabs/NotificationsSettingsTab', () => ({ default: () => <div data-testid="notifications-panel" /> }));
vi.mock('@/modules/settings/tabs/tasks-settings/TasksSettingsTab', () => ({ default: () => <div data-testid="tasks-panel" /> }));
vi.mock('@/modules/settings/tabs/AboutTab', () => ({ default: () => <div data-testid="about-panel" /> }));
vi.mock('@/modules/plugins', () => ({ PluginSettingsTab: () => <div data-testid="plugins-panel" /> }));

test('the complete settings dialog names its remote and retains every existing settings section', () => {
  const close = vi.fn();
  render(<Settings isOpen onClose={close} remoteName="Server Alpha" projects={[{ name: 'project-a', fullPath: '/remote/alpha' }]} />);
  expect(screen.getByRole('dialog', { name: 'title · Server Alpha' })).toBeTruthy();
  expect(screen.getByTestId('agents-panel').textContent).toBe('/remote/alpha');
  for (const [tab, section] of [['appearance', 'appearance'], ['git', 'git'], ['apiTokens', 'api'], ['voice', 'voice'], ['tasks', 'tasks'], ['browser', 'browser'], ['plugins', 'plugins'], ['notifications', 'notifications'], ['about', 'about']]) {
    fireEvent.click(screen.getAllByRole('button', { name: `mainTabs.${tab}` })[0]);
    expect(screen.getByTestId(`${section}-panel`)).toBeTruthy();
    expect(screen.getByRole('dialog').getAttribute('aria-labelledby')).toBe(screen.getByRole('heading', { name: 'title · Server Alpha' }).id);
  }
  fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
  expect(close).toHaveBeenCalledOnce();
});

test('opening without a selected project still shows agent settings and a close control', () => {
  render(<Settings isOpen onClose={vi.fn()} remoteName="Server Beta" />);
  expect(screen.getByRole('dialog', { name: 'title · Server Beta' })).toBeTruthy();
  expect(screen.getByTestId('agents-panel').textContent).toBe('');
  expect(screen.getByRole('button', { name: 'Close settings' })).toBeTruthy();
});
