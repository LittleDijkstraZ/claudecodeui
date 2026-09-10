import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { OverflowToolTabs } from '@/shared/ui/OverflowToolTabs';
let width = 400;
beforeEach(() => {
  localStorage.clear();
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

test('drawer resizing reveals the current scrollable tab and releases its observer when selection changes', () => {
  const observers: Array<{ resize: () => void; disconnect: ReturnType<typeof vi.fn> }> = [];
  const revealed: Element[] = [];
  const originalScroll = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: function (this: Element) { revealed.push(this); } });
  vi.stubGlobal('ResizeObserver', class {
    disconnect = vi.fn();
    observe = vi.fn();
    constructor(resize: () => void) { observers.push({ resize, disconnect: this.disconnect }); }
  });
  try {
    const close = vi.fn();
    const tabs = ['btw:1', 'btw:2'].map(id => ({ id, label: id, icon: <span />, showLabel: true, onClose: close }));
    const props = { tabs, scrollable: true, onSelect: vi.fn(), label: 'Tools', moreLabel: 'More tools', trailing: <button>Add tab</button> };
    const view = render(<OverflowToolTabs {...props} activeTab="btw:1" />);
    act(() => observers[0].resize());
    expect(revealed.at(-1)).toBe(screen.getByRole('tab', { name: 'btw:1' }));
    view.rerender(<OverflowToolTabs {...props} activeTab="btw:2" />);
    expect(observers[0].disconnect).toHaveBeenCalledOnce();
    act(() => observers[1].resize());
    expect(revealed.at(-1)).toBe(screen.getByRole('tab', { name: 'btw:2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close btw:2' }));
    expect(close).toHaveBeenCalledOnce();
    expect(props.onSelect).not.toHaveBeenCalled();
    view.unmount();
    expect(observers[1].disconnect).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
    if (originalScroll) Object.defineProperty(Element.prototype, 'scrollIntoView', originalScroll);
    else delete (Element.prototype as Partial<Element>).scrollIntoView;
  }
});
