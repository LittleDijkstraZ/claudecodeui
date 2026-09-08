import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { PluginsProvider, usePlugins } from '@/modules/plugins/context/PluginsContext';
import PluginSettingsTab from '@/modules/plugins/PluginSettingsTab';
import { api } from '@/shared/api';

vi.mock('@/shared/api',()=>({api:{plugins:{list:vi.fn(),install:vi.fn(),toggle:vi.fn(),uninstall:vi.fn(),update:vi.fn()}}}));
vi.mock('@/modules/plugins/PluginIcon',()=>({default:()=>null}));
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(key:string,values?:{defaultValue?:string})=>values?.defaultValue || key})}));
const plugin={name:'fixture-plugin',displayName:'Fixture plugin',enabled:true,entry:'index.js',version:'1.0',slot:'tab',repoUrl:null};
const response=(body:unknown)=>new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
function Inventory(){const {plugins,installPlugin}=usePlugins();return <><button onClick={()=>void installPlugin('https://example.test/plugin')}>Install fixture</button><output>{plugins.map(item=>item.name).join(',')}</output></>;}
beforeEach(()=>{vi.clearAllMocks();vi.mocked(api.plugins.list).mockResolvedValue(response({plugins:[]}));});
test('a stale initial inventory cannot remove the newly installed remote plugin',async()=>{
  let resolveInitial!:(value:Response)=>void;
  vi.mocked(api.plugins.list).mockReturnValueOnce(new Promise(resolve=>{resolveInitial=resolve;})).mockImplementation(()=>Promise.resolve(response({plugins:[plugin]})));
  vi.mocked(api.plugins.install).mockResolvedValue(response({success:true,plugin}));
  render(<PluginsProvider><Inventory/></PluginsProvider>);
  fireEvent.click(screen.getByText('Install fixture'));
  await screen.findByText('fixture-plugin');
  await act(async()=>resolveInitial(response({plugins:[]})));
  expect(screen.getByText('fixture-plugin')).toBeTruthy();
});
test('installed plugins expose an explicit Open action and backend failures keep their entry',async()=>{
  vi.mocked(api.plugins.list).mockResolvedValue(response({plugins:[{...plugin,serverError:'Fixture backend failed'}]}));
  const opened=vi.fn();window.addEventListener('cloudcli:plugin-open',opened);
  const view=render(<PluginsProvider><PluginSettingsTab/></PluginsProvider>);
  await screen.findByText('Fixture plugin');expect(screen.getByText('Fixture backend failed')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Open plugin'}));
  expect(opened).toHaveBeenCalledTimes(1);expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({name:'fixture-plugin'});
  view.unmount();window.removeEventListener('cloudcli:plugin-open',opened);
});
test('remote refresh failure preserves the installed inventory and exposes a retryable error',async()=>{
  vi.mocked(api.plugins.list).mockResolvedValueOnce(response({plugins:[plugin]})).mockRejectedValue(new Error('Fixture remote offline'));
  render(<PluginsProvider><PluginSettingsTab/></PluginsProvider>);await screen.findByText('Fixture plugin');
  fireEvent(window,new Event('focus'));await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('Fixture remote offline'));
  expect(screen.getByRole('button',{name:'Open plugin'})).toBeTruthy();
});

test('a confirmed install remains openable when its following inventory request fails',async()=>{
  vi.mocked(api.plugins.list).mockResolvedValueOnce(response({plugins:[]})).mockRejectedValue(new Error('Fixture inventory disconnected'));
  vi.mocked(api.plugins.install).mockResolvedValue(response({success:true,plugin,inventoryConfirmed:true}));
  const opened=vi.fn();window.addEventListener('cloudcli:plugin-open',opened);
  const view=render(<PluginsProvider><Inventory/><PluginSettingsTab/></PluginsProvider>);
  try {
    await waitFor(()=>expect(api.plugins.list).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText('Install fixture'));
    await screen.findByText('Fixture plugin');
    await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('Fixture inventory disconnected'));
    const open=screen.getByRole('button',{name:'Open plugin'}) as HTMLButtonElement;
    expect(open.disabled).toBe(false);fireEvent.click(open);
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({name:'fixture-plugin'});
  } finally { view.unmount();window.removeEventListener('cloudcli:plugin-open',opened); }
});

test('a raw manifest from an older server cannot fabricate an enabled installed entry',async()=>{
  vi.mocked(api.plugins.list).mockResolvedValueOnce(response({plugins:[]})).mockRejectedValue(new Error('Fixture inventory disconnected'));
  vi.mocked(api.plugins.install).mockResolvedValue(response({success:true,plugin}));
  render(<PluginsProvider><Inventory/><PluginSettingsTab/></PluginsProvider>);
  fireEvent.click(screen.getByText('Install fixture'));
  await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('Fixture inventory disconnected'));
  expect(screen.queryByRole('button',{name:'Open plugin'})).toBeNull();
  expect(screen.getByRole('button',{name:'Refresh plugins'})).toBeTruthy();
});

test('package-style plugin author and malformed optional metadata cannot crash the settings page', async () => {
  vi.mocked(api.plugins.list).mockResolvedValue(response({ plugins: [{ ...plugin, author: { name: 'Fixture author', email: 'unused@example.test' }, version: { invalid: 'object' }, description: ['unexpected'], icon: { unexpected: true }, repoUrl: { unexpected: true } }] }));
  render(<PluginsProvider><PluginSettingsTab /></PluginsProvider>);
  await screen.findByText('Fixture plugin');
  expect(screen.getByText('Fixture author')).toBeTruthy();
  expect(screen.getByText('v0.0.0')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Open plugin' })).toBeTruthy();
});

test('malformed refresh payload retains the last valid plugin instead of removing the page', async () => {
  vi.mocked(api.plugins.list).mockResolvedValueOnce(response({ plugins: [plugin] })).mockResolvedValue(response({ plugins: { wrong: 'shape' } }));
  render(<PluginsProvider><PluginSettingsTab /></PluginsProvider>);
  await screen.findByText('Fixture plugin');
  fireEvent(window, new Event('focus'));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('inventory is invalid'));
  expect(screen.getByRole('button', { name: 'Open plugin' })).toBeTruthy();
});
