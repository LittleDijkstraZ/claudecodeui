import assert from 'node:assert/strict';
import * as nodeCrypto from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import express from 'express';

import { createCompleteMessage, createNormalizedMessage } from '@/shared/index.js';

import { createAgentRouter } from '../agent.routes.js';

type AgentDependencies = Parameters<typeof createAgentRouter>[0];

function createDependencies(
  overrides: Partial<AgentDependencies> = {},
): AgentDependencies {
  const unexpectedProviderCall = async (): Promise<never> => {
    throw new Error('Provider runtime should not be called');
  };

  return {
    fileSystem: {} as AgentDependencies['fileSystem'],
    crypto: nodeCrypto,
    homeDirectory: () => '/home/test',
    spawnProcess: (() => { throw new Error('spawn should not run'); }) as unknown as
      AgentDependencies['spawnProcess'],
    platformMode: true,
    users: { getFirstUser: () => ({ id: 1, username: 'test-user' }) },
    apiKeys: { validateApiKey: () => undefined },
    githubTokens: { getActiveGithubToken: () => null },
    projects: { createProjectPath: () => ({ outcome: 'created' }) },
    models: {} as AgentDependencies['models'],
    queryClaude: unexpectedProviderCall as AgentDependencies['queryClaude'],
    queryCursor: unexpectedProviderCall as AgentDependencies['queryCursor'],
    queryCodex: unexpectedProviderCall as AgentDependencies['queryCodex'],
    queryOpenCode: unexpectedProviderCall as AgentDependencies['queryOpenCode'],
    GithubClient: class {} as unknown as AgentDependencies['GithubClient'],
    ...overrides,
  };
}

async function withAgentServer(
  dependencies: AgentDependencies,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/agent', createAgentRouter(dependencies));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('Agent route rejects missing project input before invoking provider dependencies', async () => {
  await withAgentServer(createDependencies(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Inspect this project', stream: false }),
    });
    const body = await response.json() as { error: string };

    assert.equal(response.status, 400);
    assert.equal(body.error, 'Either githubUrl or projectPath is required');
  });
});

test('Agent route validates API keys through the injected repository', async () => {
  const receivedKeys: string[] = [];
  await withAgentServer(createDependencies({
    platformMode: false,
    apiKeys: {
      validateApiKey: (apiKey) => {
        receivedKeys.push(apiKey);
        return undefined;
      },
    },
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'invalid-key' },
      body: JSON.stringify({ projectPath: '/workspace/project', message: 'Run' }),
    });
    assert.equal(response.status, 401);
  });

  assert.deepEqual(receivedKeys, ['invalid-key']);
});

test('Agent route rejects GitHub lookalike hosts before cloning', async () => {
  await withAgentServer(createDependencies(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        githubUrl: 'https://github.com.evil.example/owner/repo',
        message: 'Run',
        stream: false,
      }),
    });
    const body = await response.json() as { error: string };

    assert.equal(response.status, 500);
    assert.equal(body.error, 'Invalid GitHub URL');
  });
});

test('GitHub cloning keeps credentials out of arguments and remote URL', async () => {
  const token = 'secret-token';
  let cloneArgs: readonly string[] = [];
  let cloneEnvironment: NodeJS.ProcessEnv | undefined;
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();

  await withAgentServer(createDependencies({
    fileSystem: {
      access: async () => { throw new Error('missing'); },
      mkdir: async () => undefined,
    } as unknown as AgentDependencies['fileSystem'],
    githubTokens: { getActiveGithubToken: () => token },
    spawnProcess: ((_command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      cloneArgs = args;
      cloneEnvironment = options.env;
      process.nextTick(() => child.emit('error', new Error('expected test failure')));
      return child;
    }) as unknown as AgentDependencies['spawnProcess'],
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        githubUrl: 'https://github.com/owner/repo.git',
        message: 'Run',
        stream: false,
      }),
    });
    assert.equal(response.status, 500);
  });

  assert.deepEqual(cloneArgs.slice(0, 5), [
    'clone', '--depth', '1', '--', 'https://github.com/owner/repo.git',
  ]);
  assert.equal(cloneArgs.length, 6);
  assert.equal(cloneArgs.join(' ').includes(token), false);
  assert.equal(cloneEnvironment?.CLOUDCLI_GITHUB_TOKEN, token);
  assert.equal(cloneEnvironment?.GIT_CONFIG_KEY_0, 'credential.helper');
  assert.equal(cloneEnvironment?.GIT_CONFIG_VALUE_0, '');
  assert.equal(cloneEnvironment?.GIT_CONFIG_KEY_1, 'credential.helper');
});

test('Agent route reuses a matching checkout without cloning or deleting it', async () => {
  const spawnedArguments: string[][] = [];
  const removedPaths: string[] = [];
  const spawnProcess = ((_command: string, args: readonly string[]) => {
    spawnedArguments.push([...args]);
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      child.stdout.end('https://github.com/owner/repo.git\n');
      child.emit('close', 0);
    });
    return child;
  }) as unknown as AgentDependencies['spawnProcess'];

  await withAgentServer(createDependencies({
    fileSystem: {
      access: async () => undefined,
      rm: async (targetPath: string) => { removedPaths.push(targetPath); },
    } as unknown as AgentDependencies['fileSystem'],
    spawnProcess,
    models: {
      getProviderModels: async () => ({ models: { DEFAULT: 'default-model' } }),
    } as unknown as AgentDependencies['models'],
    queryClaude: (async () => undefined) as AgentDependencies['queryClaude'],
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        githubUrl: 'https://github.com/owner/repo.git',
        projectPath: '/home/test/.claude/external-projects/existing',
        message: 'Run',
        stream: false,
        cleanup: true,
      }),
    });
    assert.equal(response.status, 200);
  });

  assert.deepEqual(spawnedArguments, [['config', '--get', 'remote.origin.url']]);
  assert.deepEqual(removedPaths, []);
});

function createRuntimeDependencies(
  run: AgentDependencies['queryClaude'],
  overrides: Partial<AgentDependencies> = {},
): AgentDependencies {
  return createDependencies({
    fileSystem: { access: async () => undefined } as unknown as AgentDependencies['fileSystem'],
    models: { getProviderModels: async () => ({ models: { DEFAULT: 'fixture-model' } }) } as unknown as AgentDependencies['models'],
    queryClaude: run, queryCodex: run, queryCursor: run, queryOpenCode: run,
    ...overrides,
  });
}

for (const provider of ['claude', 'codex', 'cursor', 'opencode'] as const) {
  test(`Agent JSON response includes normalized ${provider} output`, async () => {
    await withAgentServer(createRuntimeDependencies(async (_command, _options, writer) => {
      writer.setSessionId?.('fixture-session');
      if (provider === 'cursor' || provider === 'opencode') {
        writer.send(createNormalizedMessage({ kind: 'stream_delta', provider, content: 'Synthetic ' }));
        writer.send(createNormalizedMessage({ kind: 'stream_delta', provider, content: 'answer' }));
      } else {
        writer.send(createNormalizedMessage({ kind: 'text', role: 'assistant', provider, content: 'Synthetic answer' }));
      }
      writer.send(createCompleteMessage({ provider, exitCode: 0 }));
    }), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/agent`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectPath: '/fixture', message: 'Run', provider, stream: false }),
      });
      const body = await response.json() as { success: boolean; sessionId: string; messages: Array<{ kind: string; content: string }> };
      assert.equal(response.status, 200);
      assert.equal(body.success, true);
      assert.equal(body.sessionId, 'fixture-session');
      assert.deepEqual(body.messages.map(message => [message.kind, message.content]), [['text', 'Synthetic answer']]);
    });
  });
}

for (const stream of [false, true]) {
  test(`Agent failure blocks publication with stream=${stream}`, async () => {
    let tokenReads = 0;
    let spawnCalls = 0;
    let githubCalls = 0;
    const emitted = [
      createNormalizedMessage({ kind: 'text', role: 'assistant', provider: 'claude', content: 'Partial result' }),
      createNormalizedMessage({ kind: 'error', provider: 'claude', content: 'Synthetic failure' }),
      createCompleteMessage({ provider: 'claude', exitCode: 1 }),
    ];
    await withAgentServer(createRuntimeDependencies(async (_command, _options, writer) => {
      for (const event of emitted) writer.send(event);
    }, {
      githubTokens: { getActiveGithubToken: () => { tokenReads++; return 'fixture-token'; } },
      spawnProcess: (() => { spawnCalls++; throw new Error('Must not publish'); }) as unknown as AgentDependencies['spawnProcess'],
      GithubClient: class { constructor() { githubCalls++; } } as unknown as AgentDependencies['GithubClient'],
    }), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/agent`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectPath: '/fixture', message: 'Run', stream, createBranch: true, createPR: true }),
      });
      if (stream) {
        assert.equal(response.status, 200); // Headers were sent before the provider failed.
        const wire = await response.text();
        for (const event of emitted) assert.ok(wire.includes(`data: ${JSON.stringify(event)}\n\n`));
        assert.ok(wire.endsWith('data: {"type":"done"}\n\n'));
        assert.equal(wire.includes('github-branch'), false);
      } else {
        const body = await response.json() as { success: boolean; error: string; messages: Array<{ content: string }> };
        assert.equal(response.status, 500);
        assert.equal(body.success, false);
        assert.equal(body.error, 'Synthetic failure');
        assert.equal(body.messages[0].content, 'Partial result');
      }
    });
    assert.equal(tokenReads, 0);
    assert.equal(spawnCalls, 0);
    assert.equal(githubCalls, 0);
  });
}

test('Agent SSE retains legacy framing and session-id events', async () => {
  const legacy = JSON.stringify({ type: 'claude-response', data: { type: 'assistant', message: { content: 'Legacy answer' } } });
  await withAgentServer(createRuntimeDependencies(async (_command, _options, writer) => {
    assert.equal(writer.isSSEStreamWriter, true);
    writer.setSessionId?.('legacy-session');
    writer.send(legacy);
    writer.send({ type: 'claude-complete', exitCode: 0 });
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectPath: '/fixture', message: 'Run', stream: true }),
    });
    const wire = await response.text();
    assert.ok(wire.includes('data: {"type":"session-id","sessionId":"legacy-session"}\n\n'));
    assert.ok(wire.includes(`data: ${JSON.stringify(legacy)}\n\n`));
    assert.ok(wire.endsWith('data: {"type":"done"}\n\n'));
  });
});
