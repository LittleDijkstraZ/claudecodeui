import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

import type { Project, ProjectSession, ShellExecutionBinding } from '@/shared/types';
import { TERMINAL_INIT_DELAY_MS } from '@/shared/constants';
import { getShellWebSocketUrl, parseShellMessage, sendSocketMessage } from '@/modules/shell/utils/socket';
import { readSelectedProvider } from '@/shared/selectedProvider';

const ANSI_ESCAPE_REGEX =
  /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u009D[^\u0007\u009C]*(?:\u0007|\u009C)|\u001B[PX^_][^\u001B]*\u001B\\|[\u0090\u0098\u009E\u009F][^\u009C]*\u009C|\u001B[@-Z\\-_])/g;
const PROCESS_EXIT_REGEX = /Process exited with code (\d+)/;

type UseShellConnectionOptions = {
  terminalInstanceId?: string;
  wsRef: MutableRefObject<WebSocket | null>;
  terminalRef: MutableRefObject<Terminal | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  selectedProjectRef: MutableRefObject<Project | null | undefined>;
  selectedSessionRef: MutableRefObject<ProjectSession | null | undefined>;
  initialCommandRef: MutableRefObject<string | null | undefined>;
  isPlainShellRef: MutableRefObject<boolean>;
  bypassPermissionsRef: MutableRefObject<boolean>;
  onProcessCompleteRef: MutableRefObject<((exitCode: number) => void) | null | undefined>;
  isInitialized: boolean;
  autoConnect: boolean;
  closeSocket: () => void;
  clearTerminalScreen: () => void;
  onOutputRef?: MutableRefObject<(() => void) | null>;
};

type UseShellConnectionResult = {
  executionBinding: ShellExecutionBinding | null;
  isConnected: boolean;
  isConnecting: boolean;
  closeSocket: () => void;
  connectToShell: (options?: { forceRestart?: boolean }) => void;
  terminateShell: () => Promise<boolean>;
  disconnectFromShell: (options?: { suppressAutoConnect?: boolean }) => void;
};

export function useShellConnection({
  terminalInstanceId,
  wsRef,
  terminalRef,
  fitAddonRef,
  selectedProjectRef,
  selectedSessionRef,
  initialCommandRef,
  isPlainShellRef,
  bypassPermissionsRef,
  onProcessCompleteRef,
  isInitialized,
  autoConnect,
  closeSocket,
  clearTerminalScreen,
  onOutputRef,
}: UseShellConnectionOptions): UseShellConnectionResult {
  // Server-confirmed terminal binding remains tied to its launch across navigation and reconnects.
  const [executionBinding, setExecutionBinding] = useState<ShellExecutionBinding | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const connectingRef = useRef(false);
  const forceRestartOnInitRef = useRef(false);
  const suppressAutoConnectRef = useRef(false);
  const terminalEndedRef = useRef(true);
  const pendingTermination = useRef<{ promise: Promise<boolean>; resolve: (stopped: boolean) => void; timer: ReturnType<typeof setTimeout> } | null>(null);
  const finishTermination = useCallback((stopped: boolean) => {
    const pending = pendingTermination.current;
    if (!pending) return;
    pendingTermination.current = null;
    clearTimeout(pending.timer);
    pending.resolve(stopped);
  }, []);
  useEffect(() => () => finishTermination(false), [finishTermination]);

  const handleProcessCompletion = useCallback(
    (output: string) => {
      if (!isPlainShellRef.current || !onProcessCompleteRef.current) {
        return;
      }

      const sanitizedOutput = output.replace(ANSI_ESCAPE_REGEX, '');
      const cleanOutput = sanitizedOutput;
      if (cleanOutput.includes('Process exited with code 0')) {
        onProcessCompleteRef.current(0);
        return;
      }

      const match = cleanOutput.match(PROCESS_EXIT_REGEX);
      if (!match) {
        return;
      }

      const exitCode = Number.parseInt(match[1], 10);
      if (!Number.isNaN(exitCode) && exitCode !== 0) {
        onProcessCompleteRef.current(exitCode);
      }
    },
    [isPlainShellRef, onProcessCompleteRef],
  );

  const handleSocketMessage = useCallback(
    (rawPayload: string) => {
      const message = parseShellMessage(rawPayload);
      if (!message) {
        console.error('[Shell] Error handling WebSocket message:', rawPayload);
        return;
      }

      if (message.type === 'process_exit' || message.type === 'terminated') {
        terminalEndedRef.current = true;
        finishTermination(true);
        return;
      }

      if (message.type === 'session_binding' && typeof message.executionId === 'string' && typeof message.appSessionId === 'string') {
        setExecutionBinding(message as unknown as ShellExecutionBinding);
        return;
      }

      if (message.type === 'output') {
        const output = typeof message.data === 'string' ? message.data : '';
        handleProcessCompletion(output);
        terminalRef.current?.write(output);
        onOutputRef?.current?.();
        return;
      }

      if (message.type === 'error') {
        finishTermination(false);
        if (message.terminalEnded === true) terminalEndedRef.current = true;
        // The server sends this instead of spawning a PTY, then keeps the
        // socket open — so without writing it out the terminal just stays
        // blank forever under a green "connected" dot. Deliberately not
        // closing the socket: `onclose` clears the screen and would erase
        // the very message being surfaced here.
        const detail = typeof message.message === 'string' && message.message
          ? message.message
          : 'Shell error';
        terminalRef.current?.write(`\r\n\x1b[31m${detail}\x1b[0m\r\n`);
        return;
      }
    },
    [finishTermination, handleProcessCompletion, onOutputRef, terminalRef],
  );

  const connectWebSocket = useCallback(
    (isConnectionLocked = false) => {
      if ((connectingRef.current && !isConnectionLocked) || isConnecting || isConnected) {
        return;
      }

      try {
        const wsUrl = getShellWebSocketUrl();
        if (!wsUrl) {
          connectingRef.current = false;
          setIsConnecting(false);
          return;
        }

        connectingRef.current = true;

        terminalEndedRef.current = false;
        const socket = new WebSocket(wsUrl);
        wsRef.current = socket;

        socket.onopen = () => {
          if (wsRef.current !== socket) return;
          setIsConnected(true);
          setIsConnecting(false);
          connectingRef.current = false;

          window.setTimeout(() => {
            if (wsRef.current !== socket || socket.readyState !== WebSocket.OPEN || suppressAutoConnectRef.current) return;
            const currentTerminal = terminalRef.current;
            const currentFitAddon = fitAddonRef.current;
            const currentProject = selectedProjectRef.current;
            if (!currentTerminal || !currentFitAddon || !currentProject) {
              return;
            }

            currentFitAddon.fit();
            const forceRestart = forceRestartOnInitRef.current;
            forceRestartOnInitRef.current = false;

            sendSocketMessage(socket, {
              type: 'init',
              terminalInstanceId,
              projectPath: currentProject.fullPath || currentProject.path || '',
              sessionId: isPlainShellRef.current ? null : selectedSessionRef.current?.id || null,
              hasSession: isPlainShellRef.current ? false : Boolean(selectedSessionRef.current),
              provider: isPlainShellRef.current ? 'plain-shell' : (selectedSessionRef.current?.__provider || readSelectedProvider()),
              cols: currentTerminal.cols,
              rows: currentTerminal.rows,
              initialCommand: initialCommandRef.current,
              isPlainShell: isPlainShellRef.current,
              forceRestart,
              // Launch-time flag: bypass mode can only join the CLI's
              // shift+tab cycle when claude starts with it.
              bypassPermissions: bypassPermissionsRef.current,
            });
          }, TERMINAL_INIT_DELAY_MS);
        };

        socket.onmessage = (event) => {
          if (wsRef.current !== socket) return;
          const rawPayload = typeof event.data === 'string' ? event.data : String(event.data ?? '');
          handleSocketMessage(rawPayload);
        };

        socket.onclose = () => {
          if (wsRef.current !== socket) return;
          finishTermination(false);
          setIsConnected(false);
          setIsConnecting(false);
          connectingRef.current = false;
          clearTerminalScreen();
        };

        socket.onerror = () => {
          if (wsRef.current !== socket) return;
          finishTermination(false);
          setIsConnected(false);
          setIsConnecting(false);
          connectingRef.current = false;
        };
      } catch {
        setIsConnected(false);
        setIsConnecting(false);
        connectingRef.current = false;
        forceRestartOnInitRef.current = false;
      }
    },
    [
      terminalInstanceId,
      bypassPermissionsRef,
      clearTerminalScreen,
      fitAddonRef,
      finishTermination,
      handleSocketMessage,
      initialCommandRef,
      isConnected,
      isConnecting,
      isPlainShellRef,
      selectedProjectRef,
      selectedSessionRef,
      terminalRef,
      wsRef,
    ],
  );

  const connectToShell = useCallback((options?: { forceRestart?: boolean }) => {
    if (!isInitialized || isConnected || isConnecting || connectingRef.current) {
      return;
    }

    forceRestartOnInitRef.current = Boolean(options?.forceRestart);
    suppressAutoConnectRef.current = false;
    connectingRef.current = true;
    setIsConnecting(true);
    connectWebSocket(true);
  }, [connectWebSocket, isConnected, isConnecting, isInitialized]);

  const disconnectFromShell = useCallback((options?: { suppressAutoConnect?: boolean }) => {
    if (options?.suppressAutoConnect) {
      suppressAutoConnectRef.current = true;
    }

    closeSocket();
    clearTerminalScreen();
    setIsConnected(false);
    setIsConnecting(false);
    connectingRef.current = false;
    forceRestartOnInitRef.current = false;
  }, [clearTerminalScreen, closeSocket]);

  const terminateShell = useCallback((): Promise<boolean> => {
    if (terminalEndedRef.current) { suppressAutoConnectRef.current = true; return Promise.resolve(true); }
    if (pendingTermination.current) return pendingTermination.current.promise;
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.resolve(false);
    let resolve!: (stopped: boolean) => void;
    const promise = new Promise<boolean>((done) => { resolve = done; });
    pendingTermination.current = { promise, resolve, timer: setTimeout(() => finishTermination(false), 5000) };
    try {
      sendSocketMessage(socket, { type: 'terminate' });
      suppressAutoConnectRef.current = true;
    } catch { finishTermination(false); }
    return promise;
  }, [finishTermination, wsRef]);

  useEffect(() => {
    if (
      !autoConnect ||
      suppressAutoConnectRef.current ||
      !isInitialized ||
      isConnecting ||
      isConnected
    ) {
      return;
    }

    connectToShell();
  }, [autoConnect, connectToShell, isConnected, isConnecting, isInitialized]);

  return {
    executionBinding,
    terminateShell,
    isConnected,
    isConnecting,
    closeSocket,
    connectToShell,
    disconnectFromShell,
  };
}
