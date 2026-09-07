import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useHubSidebar } from '@/modules/remote-hub/hooks/useHubSidebar';

let workspaceWidth = 1400;
let resize: () => void;
function Fixture() {
  const sidebar = useHubSidebar();
  return <div ref={sidebar.containerRef}>
    <button onClick={() => sidebar.setSidebarOpen(!sidebar.sidebarOpen)}>Toggle</button>
    <output data-testid="width">{sidebar.width}</output><output data-testid="narrow">{String(sidebar.narrow)}</output>
    {sidebar.sidebarOpen && <div role="separator" tabIndex={0} onKeyDown={sidebar.keyResize} />}
    <iframe title="retained remote" />
  </div>;
}
beforeEach(() => {
  localStorage.clear(); workspaceWidth = 1400;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => workspaceWidth);
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback; }
    observe() {} disconnect() {}
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('sidebar size survives collapse and reload without replacing the remote frame', () => {
  const view = render(<Fixture />);
  const frame = screen.getByTitle('retained remote');
  fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowRight' });
  expect(screen.getByTestId('width').textContent).toBe('344');
  fireEvent.click(screen.getByText('Toggle'));
  expect(screen.queryByRole('separator')).toBeNull();
  expect(screen.getByTitle('retained remote')).toBe(frame);
  fireEvent.click(screen.getByText('Toggle'));
  expect(screen.getByTestId('width').textContent).toBe('344');
  expect(screen.getByTitle('retained remote')).toBe(frame);
  view.unmount(); render(<Fixture />);
  expect(screen.getByTestId('width').textContent).toBe('344');
});

test('temporary narrow windows clamp the width but restore the preferred size when expanded', () => {
  render(<Fixture />);
  fireEvent.keyDown(screen.getByRole('separator'), { key: 'End' });
  expect(screen.getByTestId('width').textContent).toBe('560');
  act(() => { workspaceWidth = 800; resize(); });
  expect(screen.getByTestId('width').textContent).toBe('440');
  act(() => { workspaceWidth = 390; resize(); });
  expect(screen.getByTestId('narrow').textContent).toBe('true');
  expect(screen.getByTestId('width').textContent).toBe('346');
  act(() => { workspaceWidth = 1400; resize(); });
  expect(screen.getByTestId('width').textContent).toBe('560');
  fireEvent.keyDown(screen.getByRole('separator'), { key: 'Home' });
  expect(screen.getByTestId('width').textContent).toBe('220');
});
