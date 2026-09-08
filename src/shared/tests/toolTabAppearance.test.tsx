import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { useToolTabAppearance } from '@/shared/hooks/useToolTabAppearance';
import { OverflowToolTabs } from '@/shared/ui/OverflowToolTabs';

function Preference() {
  const [appearance, setAppearance] = useToolTabAppearance();
  return <select aria-label="Tool tab display" value={appearance} onChange={event => setAppearance(event.target.value === 'icons-and-text' ? 'icons-and-text' : 'icons')}><option value="icons">Icons only</option><option value="icons-and-text">Icons and text</option></select>;
}
const tabs = ['Shell', 'Files', 'Plugin'].map(label => ({ id: label.toLowerCase(), label, icon: <svg data-testid={`icon-${label}`} /> }));
function Tools() { return <OverflowToolTabs tabs={tabs} activeTab="shell" onSelect={vi.fn()} label="Tools" moreLabel="More tools" />; }

beforeEach(() => localStorage.clear());

test('defaults to accessible icons and persists appearance changes across independently mounted consumers', () => {
  const view = render(<><Preference /><Tools /><Tools /></>);
  expect((screen.getByLabelText('Tool tab display') as HTMLSelectElement).value).toBe('icons');
  expect(screen.getAllByRole('tab', { name: 'Shell' }).every(tab => tab.textContent === '' && tab.title === 'Shell')).toBe(true);
  fireEvent.change(screen.getByLabelText('Tool tab display'), { target: { value: 'icons-and-text' } });
  expect(screen.getAllByRole('tab', { name: 'Shell' }).every(tab => tab.textContent === 'Shell')).toBe(true);
  view.unmount();
  render(<><Preference /><Tools /></>);
  expect((screen.getByLabelText('Tool tab display') as HTMLSelectElement).value).toBe('icons-and-text');
  expect(screen.getByRole('tab', { name: 'Shell' }).textContent).toBe('Shell');
});

test('updates retained remote frames on the shared browser storage event without accepting unrelated storage', () => {
  render(<><Preference /><Tools /></>);
  act(() => {
    localStorage.setItem('cloudcli.workspace-tool-tab-appearance', 'icons-and-text');
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated', storageArea: localStorage }));
  });
  expect(screen.getByRole('tab', { name: 'Shell' }).textContent).toBe('');
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'cloudcli.workspace-tool-tab-appearance', storageArea: localStorage })));
  expect(screen.getByRole('tab', { name: 'Shell' }).textContent).toBe('Shell');
  act(() => {
    localStorage.clear();
    window.dispatchEvent(new StorageEvent('storage', { key: null, storageArea: localStorage }));
  });
  expect(screen.getByRole('tab', { name: 'Shell' }).textContent).toBe('');
});

test('remeasures icons versus labels so overflowed tools remain reachable after changing appearance', () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(160);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const width = this.textContent ? 100 : 44;
    return { width, height: 44, top: 0, left: 0, right: width, bottom: 44, x: 0, y: 0, toJSON: () => ({}) };
  });
  try {
    render(<><Preference /><Tools /></>);
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    fireEvent.change(screen.getByLabelText('Tool tab display'), { target: { value: 'icons-and-text' } });
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'More tools' }));
    expect(screen.getByRole('menuitem', { name: 'Plugin' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Tool tab display'), { target: { value: 'icons' } });
    expect(screen.getAllByRole('tab')).toHaveLength(3);
  } finally {
    vi.restoreAllMocks();
  }
});
