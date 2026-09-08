import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const registry = new URL('../plugin-registry.service.ts', import.meta.url).href;

for (const scenario of ['invalid-manifest', 'changed-name', 'missing-entry', 'build-failure', 'success']) {
  test(`staged plugin update: ${scenario} cannot remove the previous working inventory`, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-plugin-update-test-'));
    try {
      const plugins = path.join(directory, '.claude-code-ui', 'plugins');
      const installed = path.join(plugins, 'fixture');
      const bin = path.join(directory, 'bin');
      await mkdir(installed, { recursive: true }); await mkdir(bin);
      const original = { name: 'fixture', displayName: 'Fixture plugin', entry: 'index.js', version: '1.0', author: { name: 'Fixture author' }, description: { legacy: true } };
      await writeFile(path.join(installed, 'manifest.json'), JSON.stringify(original));
      await writeFile(path.join(installed, 'index.js'), 'export const marker = "previous";');
      await mkdir(path.join(installed, 'node_modules', '.bin'), { recursive: true });
      await mkdir(path.join(installed, 'node_modules', 'fixture-tool'), { recursive: true });
      await writeFile(path.join(installed, 'node_modules', 'fixture-tool', 'tool.mjs'), 'export const fixture = true;');
      await symlink('../fixture-tool/tool.mjs', path.join(installed, 'node_modules', '.bin', 'fixture-build'));
      if (scenario === 'build-failure') await writeFile(path.join(installed, 'package.json'), JSON.stringify({ scripts: { build: 'fixture-only' } }));
      const fakeCommand = path.join(directory, 'command.mjs');
      await writeFile(fakeCommand, `
        import fs from 'node:fs';
        import path from 'node:path';
        const scenario = ${JSON.stringify(scenario)};
        const live = ${JSON.stringify(installed)};
        // The live directory must remain readable throughout clone/build staging.
        if (!fs.readFileSync(path.join(live, 'index.js'), 'utf8').includes('previous')) process.exit(9);
        const toolLink = path.join('node_modules', '.bin', 'fixture-build');
        if (fs.readlinkSync(toolLink) !== '../fixture-tool/tool.mjs' || !fs.realpathSync(toolLink).startsWith(process.cwd() + path.sep)) {
          console.error('Staged build resolved its relative .bin link outside staging'); process.exit(9);
        }
        if (process.argv[2] === 'git') {
          if (scenario === 'invalid-manifest') fs.writeFileSync('manifest.json', '{broken');
          else {
            const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
            if (scenario === 'changed-name') manifest.name = 'different';
            if (scenario === 'missing-entry') manifest.entry = 'missing.js';
            fs.writeFileSync('manifest.json', JSON.stringify(manifest));
            fs.writeFileSync('index.js', 'export const marker = "updated";');
          }
        }
        if (process.argv[2] === 'npm' && process.argv[3] === 'run') {
          process.stdout.write('x'.repeat(200000));
          process.stderr.write('Fixture build failure');
          process.exitCode = 1;
        }
      `);
      for (const command of ['git', 'npm']) {
        await writeFile(path.join(bin, command), `#!${process.execPath}\nimport { spawnSync } from 'node:child_process';\nprocess.exit(spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(fakeCommand)}, ${JSON.stringify(command)}, ...process.argv.slice(2)], { stdio: 'inherit' }).status ?? 1);\n`, { mode: 0o755 });
      }
      // A fresh process resolves os.homedir() only inside the disposable fixture.
      const { stdout } = await exec(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
        const registry = await import(${JSON.stringify(registry)});
        let error = null;
        try { await registry.updatePluginFromGit('fixture'); } catch (caught) { error = caught.message; }
        console.log(JSON.stringify({ error, inventory: registry.scanPlugins() }));
      `], { env: { ...process.env, HOME: directory, PATH: bin + path.delimiter + process.env.PATH }, timeout: 15_000 });
      const result = JSON.parse(stdout.trim());
      assert.equal(result.inventory.length, 1);
      assert.equal(result.inventory[0].name, 'fixture');
      assert.ok(result.inventory[0].assetRevision);
      assert.equal(result.inventory[0].author, 'Fixture author');
      assert.equal(result.inventory[0].description, '');
      const current = await readFile(path.join(installed, 'index.js'), 'utf8');
      if (scenario === 'success') { assert.equal(result.error, null); assert.match(current, /updated/); }
      else { assert.ok(result.error); assert.match(current, /previous/); assert.deepEqual(JSON.parse(await readFile(path.join(installed, 'manifest.json'), 'utf8')), original); }
      if (scenario === 'build-failure') assert.match(result.error, /Fixture build failure/);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
