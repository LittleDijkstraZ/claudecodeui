import { act, renderHook } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useShellConnection } from '@/modules/shell/hooks/useShellConnection';
import type { Project, ProjectSession } from '@/shared/types';

// Only the URL builder is stubbed: it reads a stored auth token and would bail
// before a socket is ever constructed. `parseShellMessage` stays real, because
// what is under test is how a parsed frame is dispatched.
vi.mock('@/modules/shell/utils/socket', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getShellWebSocketUrl: () => 'ws://localhost/shell',
}));

class FakeSocket {
  static last: FakeSocket | null = null;
  static OPEN = 1;

  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor() {
    FakeSocket.last = this;
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  close() {
    this.readyState = 3;
  }
}

const ref = <T,>(value: T): MutableRefObject<T> => ({ current: value });

function renderConnection() {
  const write = vi.fn();
  const clearTerminalScreen = vi.fn();
  const closeSocket = vi.fn();
  const wsRef = ref<WebSocket | null>(null);
  const terminalRef = ref({ write, cols: 80, rows: 24 } as unknown as Terminal | null);

  const view = renderHook(() =>
    useShellConnection({
      wsRef,
      terminalRef,
      fitAddonRef: ref({ fit: vi.fn() } as unknown as FitAddon | null),
      selectedProjectRef: ref<Project | null | undefined>({
        fullPath: '/tmp/gone',
        path: '/tmp/gone',
      } as Project),
      selectedSessionRef: ref<ProjectSession | null | undefined>(null),
      initialCommandRef: ref<string | null | undefined>(null),
      isPlainShellRef: ref(false),
      bypassPermissionsRef: ref(false),
      onProcessCompleteRef: ref<((exitCode: number) => void) | null | undefined>(null),
      isInitialized: true,
      autoConnect: false,
      closeSocket,
      clearTerminalScreen,
    }),
  );

  act(() => {
    view.result.current.connectToShell();
  });
  act(() => {
    FakeSocket.last?.onopen?.();
  });

  return { view, write, clearTerminalScreen, closeSocket, socket: FakeSocket.last! };
}

describe('shell socket error frames', () => {
  beforeEach(() => {
    FakeSocket.last = null;
    vi.stubGlobal('WebSocket', FakeSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes the server error into the terminal instead of dropping it', () => {
    const { write, socket } = renderConnection();

    act(() => {
      socket.onmessage?.({
        data: JSON.stringify({ type: 'error', message: 'Invalid project path' }),
      });
    });

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toContain('Invalid project path');
  });

  it('keeps the socket open so the message it just wrote is not cleared', () => {
    const { clearTerminalScreen, closeSocket, socket } = renderConnection();

    act(() => {
      socket.onmessage?.({
        data: JSON.stringify({ type: 'error', message: 'Invalid session ID' }),
      });
    });

    expect(clearTerminalScreen).not.toHaveBeenCalled();
    expect(closeSocket).not.toHaveBeenCalled();
    expect(socket.readyState).toBe(1);
  });

  it('falls back to a generic label when the frame carries no message', () => {
    const { write, socket } = renderConnection();

    act(() => {
      socket.onmessage?.({ data: JSON.stringify({ type: 'error' }) });
    });

    expect(write.mock.calls[0][0]).toContain('Shell error');
  });

  it('still writes plain output frames unchanged', () => {
    const { write, socket } = renderConnection();

    act(() => {
      socket.onmessage?.({ data: JSON.stringify({ type: 'output', data: 'hello' }) });
    });

    expect(write).toHaveBeenCalledWith('hello');
  });

  it('waits for the stopped acknowledgement before declaring termination successful', async () => {
    const { view, socket } = renderConnection();
    let settled = false;
    const result = view.result.current.terminateShell().then((value) => { settled = true; return value; });
    expect(socket.sent.map((frame) => JSON.parse(frame))).toContainEqual({ type: 'terminate' });
    await Promise.resolve();
    expect(settled).toBe(false);
    act(() => { socket.onmessage?.({ data: JSON.stringify({ type: 'terminated' }) }); });
    expect(await result).toBe(true);
  });

  it('retains an unknown disconnected process and reports rejected stops', async () => {
    const { view, socket } = renderConnection();
    const rejected = view.result.current.terminateShell();
    act(() => { socket.onmessage?.({ data: JSON.stringify({ type: 'error', message: 'Unable to stop', terminalEnded: false }) }); });
    expect(await rejected).toBe(false);
    const disconnected = view.result.current.terminateShell();
    act(() => { socket.readyState = 3; socket.onclose?.(); });
    expect(await disconnected).toBe(false);
    expect(await view.result.current.terminateShell()).toBe(false);
  });

  it('times out a stop without acknowledgement', async () => {
    vi.useFakeTimers();
    try {
      const { view } = renderConnection();
      const result = view.result.current.terminateShell();
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(await result).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('allows closing an acknowledged ended process without reconnecting and starting a new one', async () => {
    const { view, socket } = renderConnection();
    act(() => { socket.onmessage?.({ data: JSON.stringify({ type: 'process_exit', exitCode: 0 }) }); });
    socket.readyState = 3;
    expect(await view.result.current.terminateShell()).toBe(true);
    expect(socket.sent.some((frame) => JSON.parse(frame).type === 'init')).toBe(false);
  });
});
