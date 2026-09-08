import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';

import { scopedRemoteStorage } from '@/modules/remote-transport';
import { useToolTabAppearance } from '@/shared/hooks/useToolTabAppearance';

function Choice() {
  const [appearance, setAppearance] = useToolTabAppearance();
  return <button onClick={() => setAppearance('icons-and-text')}>{appearance}</button>;
}

const storage = window.localStorage;
afterEach(() => {
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
  delete window.__CLOUDCLI_BROWSER_STORAGE__;
  storage.clear();
});

test('toolbar appearance belongs to the original browser store while drafts and auth stay remote-scoped', () => {
  storage.clear();
  window.__CLOUDCLI_BROWSER_STORAGE__ = storage;
  const alpha = scopedRemoteStorage(storage, 'alpha');
  const beta = scopedRemoteStorage(storage, 'beta');
  Object.defineProperty(window, 'localStorage', { configurable: true, value: alpha });
  alpha.setItem('draft:same-id', 'alpha draft');
  beta.setItem('draft:same-id', 'beta draft');
  const view = render(<Choice />);
  fireEvent.click(screen.getByRole('button', { name: 'icons' }));
  expect(storage.getItem('cloudcli.workspace-tool-tab-appearance')).toBe('icons-and-text');
  expect(alpha.getItem('cloudcli.workspace-tool-tab-appearance')).toBeNull();
  view.unmount();
  Object.defineProperty(window, 'localStorage', { configurable: true, value: beta });
  render(<Choice />);
  expect(screen.getByRole('button', { name: 'icons-and-text' })).toBeTruthy();
  expect(alpha.getItem('draft:same-id')).toBe('alpha draft');
  expect(beta.getItem('draft:same-id')).toBe('beta draft');
});
