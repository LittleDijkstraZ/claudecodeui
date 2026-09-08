import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import AppearanceSettingsTab from '@/modules/settings/tabs/AppearanceSettingsTab';
import { OverflowToolTabs } from '@/shared/ui/OverflowToolTabs';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/modules/i18n', () => ({ LanguageSelector: () => null }));
vi.mock('@/shared/ui', () => ({ DarkModeToggle: () => null }));

beforeEach(() => localStorage.clear());

test('Appearance settings immediately changes the retained toolbar without writing remote settings', () => {
  const unrelatedSettings = vi.fn();
  render(<><AppearanceSettingsTab projectSortOrder="name" onProjectSortOrderChange={unrelatedSettings} codeEditorSettings={{ wordWrap: true, showMinimap: true, lineNumbers: true, fontSize: '14' }} onCodeEditorWordWrapChange={unrelatedSettings} onCodeEditorShowMinimapChange={unrelatedSettings} onCodeEditorLineNumbersChange={unrelatedSettings} onCodeEditorFontSizeChange={unrelatedSettings} /><OverflowToolTabs tabs={[{ id: 'files', label: 'Files', icon: <svg /> }]} activeTab="files" onSelect={vi.fn()} label="Tools" moreLabel="More tools" /></>);
  const choice = screen.getByRole('combobox', { name: 'appearanceSettings.toolTabs.label' });
  expect((choice as HTMLSelectElement).value).toBe('icons');
  expect(screen.getByRole('tab', { name: 'Files' }).textContent).toBe('');
  fireEvent.change(choice, { target: { value: 'icons-and-text' } });
  expect(screen.getByRole('tab', { name: 'Files' }).textContent).toBe('Files');
  expect(unrelatedSettings).not.toHaveBeenCalled();
});
