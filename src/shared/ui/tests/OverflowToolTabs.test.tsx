import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { OverflowToolTabs } from '@/shared/ui/OverflowToolTabs';
let width = 400;
beforeEach(() => {
  width = 400;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width: 90, height: 44, top: 0, left: 0, right: 90, bottom: 44, x: 0, y: 0, toJSON: () => ({}) }));
});
afterEach(() => vi.restoreAllMocks());
test('measures overflow, preserves the selected hidden tool and keeps it reachable through More', () => {
  const select = vi.fn();
  const tabs = ['shell','files','plugin:research'].map(id => ({ id, label: id, icon: <span /> }));
  render(<OverflowToolTabs tabs={tabs} activeTab="plugin:research" onSelect={select} label="Tools" moreLabel="More tools" />);
  expect(screen.getAllByRole('tab')).toHaveLength(3);
  act(() => { width = 150; window.dispatchEvent(new Event('resize')); });
  expect(screen.getAllByRole('tab')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'More tools · plugin:research' }));
  fireEvent.click(screen.getByRole('menuitem', { name: /plugin:research/ }));
  expect(select).toHaveBeenCalledWith('plugin:research');
  act(() => { width = 400; window.dispatchEvent(new Event('resize')); });
  expect(screen.getByRole('tab', { name: 'plugin:research' }).getAttribute('aria-selected')).toBe('true');
});
