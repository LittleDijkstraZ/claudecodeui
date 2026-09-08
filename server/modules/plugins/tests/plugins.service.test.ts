import assert from 'node:assert/strict';
import test from 'node:test';

import { createPluginsService } from '../plugins.service.js';

type Dependencies = Parameters<typeof createPluginsService>[0];

function dependencies(overrides: Partial<Dependencies> = {}): Dependencies {
  return {
    scanPlugins: () => [], readConfig: () => ({}), saveConfig: () => undefined,
    getPluginDirectory: () => null, getPluginsDirectory: () => '/plugins',
    resolveAsset: () => null, assetIsFile: () => false, contentType: () => 'text/plain',
    install: async () => ({ name: 'plugin', dirName: 'plugin' }),
    update: async () => ({ name: 'plugin', dirName: 'plugin' }),
    uninstall: async () => undefined, startServer: async () => 4000,
    stopServer: async () => undefined, getServerPort: () => undefined,
    isServerRunning: () => false, joinPath: (...parts) => parts.join('/'),
    logError: () => undefined, ...overrides,
  };
}

test('setEnabled persists configuration and starts an enabled plugin server', async () => {
  const operations: string[] = [];
  const service = createPluginsService(dependencies({
    scanPlugins: () => [{ name: 'demo', dirName: 'demo', server: { entry: 'server.js' } }],
    getPluginDirectory: () => '/plugins/demo',
    saveConfig: () => operations.push('save'),
    startServer: async () => { operations.push('start'); return 4000; },
  }));
  await service.setEnabled('demo', true);
  assert.deepEqual(operations, ['save', 'start']);
});

test('an installed plugin remains visible with a specific backend warning and can retry', async () => {
  const plugin={name:'demo',dirName:'demo',server:'server.js',enabled:true};let running=false;
  const service=createPluginsService(dependencies({ scanPlugins:()=>[plugin],install:async()=>plugin,getPluginDirectory:()=>'/plugins/demo',
    startServer:async()=>{if(!running)throw new Error('Fixture backend could not bind its port');return 4444;},isServerRunning:()=>running }));
  const installed=await service.install('https://example.test/fixture');
  assert.equal(installed.success,true);assert.match(installed.warning || '',/could not bind/);
  assert.equal(installed.inventoryConfirmed,true);assert.equal(installed.plugin.enabled,true);
  assert.equal(service.list().plugins[0].name,'demo');assert.match(service.list().plugins[0].serverError || '',/could not bind/);
  running=true;await service.setEnabled('demo',true);
  assert.equal(service.list().plugins[0].enabled,true);
});

test('installation returns actual inventory state rather than guessing enabled from its raw manifest', async () => {
  const manifest={name:'disabled-fixture',displayName:'Fixture',entry:'index.js'};
  const service=createPluginsService(dependencies({install:async()=>manifest,scanPlugins:()=>[{...manifest,enabled:false,dirName:'fixture-directory'}]}));
  const result=await service.install('https://example.test/fixture');
  assert.equal(result.inventoryConfirmed,true);
  assert.equal(result.plugin.enabled,false);
  assert.equal(result.plugin.dirName,'fixture-directory');
});

test('an inventory scan failure does not turn a completed installation into an install failure', async () => {
  const service=createPluginsService(dependencies({scanPlugins:()=>{throw new Error('Fixture inventory unavailable');}}));
  const result=await service.install('https://example.test/fixture');
  assert.equal(result.success,true);assert.equal(result.inventoryConfirmed,false);
  assert.match(result.warning || '',/Refresh plugins/);
});
