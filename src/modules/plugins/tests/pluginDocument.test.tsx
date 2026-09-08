import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import PluginTabContent from '@/modules/plugins/PluginTabContent';
import { api } from '@/shared/api';

const fixture = vi.hoisted(() => ({ plugins: [{ name: 'fixture', displayName: 'Fixture plugin', entry: 'index.js', enabled: true, version: '1', assetRevision: 'first' }] }));
vi.mock('@/shared/api', () => ({ api: { plugins: { asset: vi.fn(), rpc: vi.fn() } } }));
vi.mock('@/modules/plugins/context/PluginsContext', () => ({ usePlugins: () => ({ plugins: fixture.plugins, loading: false, pluginsError: null, refreshPlugins: vi.fn() }) }));
vi.mock('@/shared/context/ThemeContext', () => ({ useTheme: () => ({ isDarkMode: false }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string; error?: string }) => options?.error || options?.defaultValue || key }) }));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.plugins[0].assetRevision = 'first';
  vi.mocked(api.plugins.asset).mockImplementation(async () => new Response('export function mount() {}'));
  URL.createObjectURL = vi.fn(() => 'blob:fixture');
  URL.revokeObjectURL = vi.fn();
});

async function frameHost() {
  const frame = await screen.findByTitle('Fixture plugin') as HTMLIFrameElement;
  // JSDOM does not fetch the static host document; supply its minimal DOM fixture.
  frame.contentDocument?.open();
  frame.contentDocument?.write('<html><head></head><body><div id="plugin-root"></div></body></html>');
  frame.contentDocument?.close();
  fireEvent.load(frame);
  return { frame, host: (frame.contentWindow as unknown as { __cloudcliPluginHost: {
    failed(error: string): void;
    ready(unmount: () => void): void;
    api: { rpc(method: string, path: string): Promise<unknown>; onContextChange(cb: (context: unknown) => void): () => void };
  } }).__cloudcliPluginHost };
}

test('plugin loads in its own document and host recovery stays outside it', async () => {
  render(<div><span>Host conversation remains</span><PluginTabContent pluginName="fixture" selectedProject={null} selectedSession={null} /></div>);
  const { frame, host } = await frameHost();
  expect(frame.getAttribute('sandbox')).toContain('allow-scripts');
  expect(frame.src).toContain('/plugin-host.html');
  act(() => host.failed('Fixture plugin mount failed'));
  expect(screen.getByRole('alert').textContent).toContain('Fixture plugin mount failed');
  expect(screen.getByRole('alert').textContent).toContain('single-file browser bundle');
  expect(screen.getByText('Host conversation remains')).toBeTruthy();
  fireEvent.click(screen.getByText('settings:pluginSettings.retryOpen'));
  await waitFor(() => expect(api.plugins.asset).toHaveBeenCalledTimes(2));
  expect(frame.isConnected).toBe(false);
});

test('same-version artifact update reloads only its plugin and ignores errors from the retired mount', async () => {
  const view = render(<PluginTabContent pluginName="fixture" selectedProject={null} selectedSession={null} />);
  const initial = await frameHost(); const unmount = vi.fn();
  act(() => initial.host.ready(unmount));
  fixture.plugins[0].assetRevision = 'updated';
  view.rerender(<PluginTabContent pluginName="fixture" selectedProject={null} selectedSession={null} />);
  await waitFor(() => expect(api.plugins.asset).toHaveBeenCalledTimes(2));
  expect(initial.frame.isConnected).toBe(false); expect(unmount).toHaveBeenCalledTimes(1);
  act(() => initial.host.failed('Old mount error'));
  expect(screen.queryByRole('alert')).toBeNull();
});

test('plugin RPC preserves empty and text responses without inventing JSON parse failures', async () => {
  render(<PluginTabContent pluginName="fixture" selectedProject={null} selectedSession={null} />);
  const { host } = await frameHost();
  vi.mocked(api.plugins.rpc).mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(new Response('fixture text'));
  await expect(host.api.rpc('POST', '/empty')).resolves.toBeNull();
  await expect(host.api.rpc('GET', '/text')).resolves.toBe('fixture text');
  expect(api.plugins.rpc).toHaveBeenNthCalledWith(1, 'fixture', 'POST', '/empty', undefined);
});
