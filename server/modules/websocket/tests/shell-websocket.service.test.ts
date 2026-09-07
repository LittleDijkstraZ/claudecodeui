import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import { handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: string[];
    send: (data: string) => void;
  };
  socket.readyState = WebSocket.OPEN;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(data);
  return socket;
}

function createFakePty() {
  let dataListener: ((data: string) => void) | null = null;
  let exitListener: ((event: { exitCode: number; signal?: number }) => void) | null = null;

  return {
    killed: false,
    onData(listener: (data: string) => void) {
      dataListener = listener;
      return { dispose: () => undefined };
    },
    onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
      exitListener = listener;
      return { dispose: () => undefined };
    },
    emitData(data: string) {
      dataListener?.(data);
    },
    emitExit(exitCode = 0) {
      exitListener?.({ exitCode });
    },
    write() {},
    resize() {},
    kill() {
      this.killed = true;
    },
  };
}

test('a stale socket close cannot detach the socket that replaced it', () => {
  const pty = createFakePty();
  const dependencies = {
    resolveProviderSessionId: () => null,
    spawnPty: () => pty as never,
  };
  const initMessage = JSON.stringify({
    type: 'init',
    projectPath: process.cwd(),
    sessionId: `stale-close-${Date.now()}`,
    hasSession: false,
    provider: 'plain-shell',
    isPlainShell: true,
    initialCommand: 'test-command',
  });

  const firstSocket = createFakeSocket();
  handleShellConnection(firstSocket as never, dependencies);
  firstSocket.emit('message', initMessage);

  const replacementSocket = createFakeSocket();
  handleShellConnection(replacementSocket as never, dependencies);
  replacementSocket.emit('message', initMessage);
  replacementSocket.frames.length = 0;

  // This ordering reproduces a delayed close from a backgrounded mobile tab.
  firstSocket.emit('close');
  pty.emitData('output-after-stale-close');

  assert.equal(pty.killed, false);
  assert.equal(replacementSocket.frames.length, 1);
  assert.match(replacementSocket.frames[0], /output-after-stale-close/);

  pty.emitExit();
});

test('shell output detects and normalizes a wrapped authentication URL', () => {
  const pty = createFakePty();
  const socket = createFakeSocket();
  const dependencies = {
    resolveProviderSessionId: () => null,
    spawnPty: () => pty as never,
  };

  handleShellConnection(socket as never, dependencies);
  socket.emit(
    'message',
    JSON.stringify({
      type: 'init',
      projectPath: process.cwd(),
      sessionId: `wrapped-url-${Date.now()}`,
      hasSession: false,
      provider: 'plain-shell',
      isPlainShell: true,
      initialCommand: 'test-command',
    })
  );
  socket.frames.length = 0;

  pty.emitData("Continue in your browser: https://example.com/authorize?\ncode=abc\x1b[0m");

  const frames = socket.frames.map((frame) => JSON.parse(frame) as Record<string, unknown>);
  const authenticationFrame = frames.find((frame) => frame.type === 'auth_url');
  assert.deepEqual(authenticationFrame, {
    type: 'auth_url',
    url: 'https://example.com/authorize?code=abc',
    autoOpen: false,
  });

  pty.emitExit();
});

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test('failed Claude resume never creates another session and reconnect preserves its execution binding', async () => {
  const terminal = createFakePty();
  const launches: Array<{ executable: string; args: string[] }> = [];
  const finished: unknown[] = [];
  const record = { executionId: `execution-${Date.now()}`, appSessionId: `app-${Date.now()}`, providerSessionId: 'native-fixture', surface: 'shell' as const,
    projectPath: process.cwd(), requested: { model: 'fixture-exact', effort: 'xhigh', ultracode: true, revision: 'fixture' },
    startedAt: new Date().toISOString(), endedAt: null, status: 'running' as const, observed: {} };
  const dependencies = {
    resolveProviderSessionId: () => 'native-fixture',
    prepareClaudeSession: async () => ({ executable: '/fixture/claude', args: ['--resume', 'native-fixture', '--model', 'fixture-exact', '--effort', 'xhigh'], record }),
    spawnPty: (executable: string, args: string | string[]) => { launches.push({ executable, args: Array.isArray(args) ? args : [args] }); return terminal as never; },
    finishExecution: (...args: unknown[]) => { finished.push(args); },
  };
  const init = JSON.stringify({ type: 'init', projectPath: process.cwd(), sessionId: record.appSessionId, hasSession: true, provider: 'claude' });
  const first = createFakeSocket();
  handleShellConnection(first as never, dependencies);
  first.emit('message', init);
  await settle();
  const second = createFakeSocket();
  handleShellConnection(second as never, dependencies);
  second.emit('message', init);
  await settle();
  assert.equal(launches.length, 1);
  assert.equal(launches[0].executable, '/fixture/claude');
  assert.deepEqual(launches[0].args, ['--resume', 'native-fixture', '--model', 'fixture-exact', '--effort', 'xhigh']);
  assert.ok(second.frames.some((frame) => JSON.parse(frame).executionId === record.executionId));
  terminal.emitExit(1);
  await settle();
  assert.equal(launches.length, 1);
  assert.deepEqual(finished, [[record.executionId, true]]);
});

test('two concurrent Claude init requests reserve one PTY while configuration loads', async () => {
  let release!: () => void;
  const preparing = new Promise<void>((resolve) => { release = resolve; });
  const terminal = createFakePty();
  let launches = 0;
  const sessionId = `pending-${Date.now()}`;
  const dependencies = {
    resolveProviderSessionId: () => 'native-pending',
    prepareClaudeSession: async () => { await preparing; return { executable: '/fixture/claude', args: ['--resume', 'native-pending'], record: {
      executionId: 'execution-pending', appSessionId: sessionId, providerSessionId: 'native-pending', surface: 'shell' as const,
      projectPath: process.cwd(), requested: { model: 'default', effort: 'default', ultracode: false, revision: 'fixture' },
      startedAt: new Date().toISOString(), endedAt: null, status: 'running' as const, observed: {},
    } }; },
    spawnPty: () => { launches++; return terminal as never; },
  };
  const init = JSON.stringify({ type: 'init', projectPath: process.cwd(), sessionId, hasSession: true, provider: 'claude' });
  const first = createFakeSocket(); const second = createFakeSocket();
  handleShellConnection(first as never, dependencies); handleShellConnection(second as never, dependencies);
  first.emit('message', init); second.emit('message', init);
  release(); await settle();
  assert.equal(launches, 1);
  assert.ok(second.frames.some((frame) => /still starting/.test(frame)));
  terminal.emitExit();
});

test('unmapped Claude sessions fail visibly and never fall back to a fresh CLI', async () => {
  let launches = 0;
  const socket = createFakeSocket();
  handleShellConnection(socket as never, {
    resolveProviderSessionId: () => null,
    prepareClaudeSession: async () => { throw new Error('No provider session exists'); },
    spawnPty: () => { launches++; return createFakePty() as never; },
  });
  socket.emit('message', JSON.stringify({ type: 'init', projectPath: process.cwd(), sessionId: `missing-${Date.now()}`, hasSession: true, provider: 'claude' }));
  await settle();
  assert.equal(launches, 0);
  assert.ok(socket.frames.some((frame) => JSON.parse(frame).type === 'error'));
});

test('plain terminal instance IDs create independent PTYs in the same project', () => {
  const terminals: ReturnType<typeof createFakePty>[] = [];
  const dependencies = { resolveProviderSessionId: () => null, spawnPty: () => { const terminal = createFakePty(); terminals.push(terminal); return terminal as never; } };
  for (const terminalInstanceId of ['one', 'two']) {
    const socket = createFakeSocket(); handleShellConnection(socket as never, dependencies);
    socket.emit('message', JSON.stringify({ type: 'init', projectPath: process.cwd(), provider: 'plain-shell', isPlainShell: true, terminalInstanceId }));
  }
  assert.equal(terminals.length, 2);
  terminals.forEach((terminal) => terminal.emitExit());
});

test('bypassPermissions cannot turn an unbound terminal into a new Claude session', () => {
  const spawnedCommands: string[] = [];
  const dependencies = {
    resolveProviderSessionId: () => null,
    spawnPty: (_shell: string, args: string | string[]) => {
      spawnedCommands.push(Array.isArray(args) ? args[args.length - 1] : args);
      return createFakePty() as never;
    },
  };

  const bypassSocket = createFakeSocket();
  handleShellConnection(bypassSocket as never, dependencies);
  bypassSocket.emit(
    'message',
    JSON.stringify({
      type: 'init',
      projectPath: process.cwd(),
      sessionId: `bypass-on-${Date.now()}`,
      hasSession: false,
      provider: 'claude',
      bypassPermissions: true,
    })
  );

  const defaultSocket = createFakeSocket();
  handleShellConnection(defaultSocket as never, dependencies);
  defaultSocket.emit(
    'message',
    JSON.stringify({
      type: 'init',
      projectPath: process.cwd(),
      sessionId: `bypass-off-${Date.now()}`,
      hasSession: false,
      provider: 'claude',
    })
  );

  assert.deepEqual(spawnedCommands, []);
  assert.ok(bypassSocket.frames.some((frame) => JSON.parse(frame).type === 'error'));
  assert.ok(defaultSocket.frames.some((frame) => JSON.parse(frame).type === 'error'));
});

test('bypassPermissions carries through to resumed claude sessions', async () => {
  const spawnedCommands: string[] = [];
  const dependencies = {
    resolveProviderSessionId: () => 'resumed-session-id',
    prepareClaudeSession: async (sessionId: string) => ({ executable: '/fixture/claude', args: ['--resume', 'resumed-session-id'], record: {
      executionId: 'bypass-fixture', appSessionId: sessionId, providerSessionId: 'resumed-session-id', projectPath: process.cwd(),
      surface: 'shell' as const, requested: { model: 'default', effort: 'default', ultracode: false, revision: 'fixture' },
      startedAt: new Date().toISOString(), endedAt: null, status: 'running' as const, observed: {},
    } }),
    spawnPty: (_shell: string, args: string | string[]) => {
      spawnedCommands.push(Array.isArray(args) ? args[args.length - 1] : args);
      return createFakePty() as never;
    },
  };

  const socket = createFakeSocket();
  handleShellConnection(socket as never, dependencies);
  socket.emit(
    'message',
    JSON.stringify({
      type: 'init',
      projectPath: process.cwd(),
      sessionId: `bypass-resume-${Date.now()}`,
      hasSession: true,
      provider: 'claude',
      bypassPermissions: true,
    })
  );

  await settle();
  assert.equal(spawnedCommands.length, 1);
  assert.equal(spawnedCommands[0], '--dangerously-skip-permissions');
});

test('a missing project directory is reported as an error frame and starts no pty', () => {
  const socket = createFakeSocket();
  let spawnCount = 0;
  const dependencies = {
    resolveProviderSessionId: () => null,
    spawnPty: () => {
      spawnCount += 1;
      return createFakePty() as never;
    },
  };

  handleShellConnection(socket as never, dependencies);
  socket.emit(
    'message',
    JSON.stringify({
      type: 'init',
      // A project row survives its directory being deleted or unmounted, so
      // this is what the Shell tab sends for a stale sidebar entry.
      projectPath: path.join(os.tmpdir(), `shell-missing-${Date.now()}`),
      sessionId: `missing-path-${Date.now()}`,
      hasSession: false,
      provider: 'plain-shell',
      isPlainShell: true,
    })
  );

  assert.equal(spawnCount, 0);
  assert.deepEqual(
    socket.frames.map((frame) => JSON.parse(frame) as Record<string, unknown>),
    [{ type: 'error', message: 'Invalid project path', terminalEnded: true }]
  );
});


test('explicit terminate stops only its bound PTY; a replaced socket cannot stop the active connection', async () => {
  const firstPty = createFakePty(); const otherPty = createFakePty(); let count = 0;
  const dependencies = { resolveProviderSessionId: () => null, spawnPty: () => (++count === 1 ? firstPty : otherPty) as never };
  const key = `terminate-${Date.now()}`;
  const init = (terminalInstanceId: string) => JSON.stringify({ type: 'init', projectPath: process.cwd(), provider: 'plain-shell', terminalInstanceId });
  const first = createFakeSocket(); const replacement = createFakeSocket(); const other = createFakeSocket();
  for (const socket of [first, replacement, other]) handleShellConnection(socket as never, dependencies);
  first.emit('message', init(key)); replacement.emit('message', init(key)); other.emit('message', init(`${key}-other`));
  first.emit('message', JSON.stringify({ type: 'terminate' }));
  assert.equal(firstPty.killed, false);
  assert.ok(first.frames.some((frame) => JSON.parse(frame).type === 'error'));
  replacement.emit('message', JSON.stringify({ type: 'terminate' }));
  assert.equal(firstPty.killed, true);
  assert.equal(otherPty.killed, false);
  assert.equal(replacement.frames.some((frame) => JSON.parse(frame).type === 'terminated'), false);
  firstPty.emitExit();
  assert.ok(replacement.frames.some((frame) => JSON.parse(frame).type === 'terminated'));
  otherPty.emitExit();
});

test('terminate during pending Claude configuration cancels launch before any PTY starts', async () => {
  let release!: () => void; const pending = new Promise<void>((resolve) => { release = resolve; });
  let launches = 0;
  const socket = createFakeSocket();
  handleShellConnection(socket as never, { resolveProviderSessionId: () => 'native-pending-close',
    prepareClaudeSession: async () => { await pending; return { executable: '/fixture/claude', args: [], record: {} as never }; },
    spawnPty: () => { launches++; return createFakePty() as never; },
  });
  socket.emit('message', JSON.stringify({ type: 'init', projectPath: process.cwd(), sessionId: `closing-${Date.now()}`, provider: 'claude', hasSession: true }));
  socket.emit('message', JSON.stringify({ type: 'terminate' }));
  release(); await settle();
  assert.equal(launches, 0);
});


test('an empty plain terminal starts an interactive shell rather than an empty command that immediately exits', () => {
  const terminal = createFakePty();
  let launch: { executable: string; args: string | string[] } | null = null;
  const socket = createFakeSocket();
  handleShellConnection(socket as never, { resolveProviderSessionId: () => null,
    spawnPty: (executable, args) => { launch = { executable, args }; return terminal as never; },
  });
  socket.emit('message', JSON.stringify({ type: 'init', projectPath: process.cwd(), provider: 'plain-shell', terminalInstanceId: `interactive-${Date.now()}` }));
  assert.deepEqual(launch, os.platform() === 'win32' ? { executable: 'powershell.exe', args: ['-NoExit'] } : { executable: 'bash', args: ['-i'] });
  terminal.emitExit();
});


test('saved permissions reach only the bound Claude launch and cannot conflict with the bypass flag', async () => {
  const terminal = createFakePty(); let preparedPermissions: unknown;
  const socket = createFakeSocket(); let launches = 0;
  const sessionId = `permission-fixture-${Date.now()}`;
  handleShellConnection(socket as never, { resolveProviderSessionId: () => 'native-permission-fixture',
    prepareClaudeSession: async (_id, _provider, _project, permissions) => {
      preparedPermissions = permissions;
      return { executable: '/fixture/claude', args: ['--resume', 'native-permission-fixture'], record: {
        executionId: sessionId, appSessionId: sessionId, providerSessionId: 'native-permission-fixture', surface: 'shell',
        projectPath: process.cwd(), requested: { model: 'default', effort: 'default', ultracode: false, revision: 'fixture' },
        status: 'running', startedAt: new Date().toISOString(), endedAt: null, observed: {},
      } };
    }, spawnPty: () => { launches++; return terminal as never; },
  });
  socket.emit('message', JSON.stringify({ type: 'init', projectPath: process.cwd(), sessionId, hasSession: true, provider: 'claude',
    permissionMode: 'acceptEdits', bypassPermissions: false,
    toolsSettings: { allowedTools: ['Read(//tmp/turn_00.txt)'], disallowedTools: ['Bash(rm *)'], skipPermissions: false },
  }));
  await settle();
  assert.deepEqual(preparedPermissions, { mode: 'acceptEdits', allowedTools: ['Read(//tmp/turn_00.txt)'], disallowedTools: ['Bash(rm *)'] });
  assert.equal(launches, 1); terminal.emitExit();
  const conflicting = createFakeSocket();
  handleShellConnection(conflicting as never, { resolveProviderSessionId: () => null, spawnPty: () => { assert.fail('conflicting permission settings must not launch'); } });
  conflicting.emit('message', JSON.stringify({ type: 'init', projectPath: process.cwd(), sessionId: `${sessionId}-conflict`, hasSession: true, provider: 'claude', permissionMode: 'plan', bypassPermissions: true }));
  await settle();
  assert.ok(conflicting.frames.some((frame) => JSON.parse(frame).message?.includes('Conflicting')));
});
