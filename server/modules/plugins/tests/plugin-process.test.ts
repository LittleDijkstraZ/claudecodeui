import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isPluginRunning, startPluginServer, stopPluginServer } from '../plugin-process.service.js';

test('disabling a plugin during startup waits for and stops that same subprocess', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-plugin-process-test-'));
  const name = 'fixture-starting-plugin';
  try {
    await writeFile(path.join(directory, 'server.mjs'), 'setTimeout(() => console.log(JSON.stringify({ ready: true, port: 49199 })), 30); setInterval(() => {}, 1000);');
    const starting = startPluginServer(name, directory, 'server.mjs');
    const stopping = stopPluginServer(name);
    await Promise.all([starting, stopping]);
    assert.equal(isPluginRunning(name), false);
  } finally { await stopPluginServer(name); await rm(directory, { recursive: true, force: true }); }
});
