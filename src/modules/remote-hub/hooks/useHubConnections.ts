import { useCallback, useEffect, useRef, useState } from 'react';

import { hubApi, remoteToken } from '@/shared/api';
import type { HubRemote, HubRemoteState } from '@/shared/types';
import { getHubUnread, readHubConversation, recordHubUnread } from '@/modules/remote-hub/utils/hubUnread';
import { normalizeConversation } from '@/modules/remote-hub/utils/hubClient';
const initial = (): HubRemoteState => ({
  status: 'loading',
  projects: [],
  conversations: [],
  total: 0,
  running: [],
  attention: []
});
export function useHubConnections(remotes: HubRemote[], onNotification: (remoteId: string, sessionId: string, label: string) => void) {
  // Each remote retains independent data and failure state so one outage cannot blank the others.
  const [states, setStates] = useState<Record<string, HubRemoteState>>({});
  const busy = useRef(new Map<string, number>());
  const latestStates = useRef(states);
  latestStates.current = states;
  const activityRevision = useRef(new Map<string, number>());
  const notificationKeys = useRef(new Set<string>());
  const generation = useRef(0);
  const notifyRef = useRef(onNotification);
  notifyRef.current = onNotification;
  const refresh = useCallback(async (remoteId: string) => {
    const version = generation.current;
    const snapshotRevision = activityRevision.current.get(remoteId) ?? 0;
    if (busy.current.get(remoteId) === version) return;
    busy.current.set(remoteId, version);
    try {
      await hubApi.health(remoteId);
      if (!remoteToken(remoteId)) throw new Error('LOGIN_REQUIRED');
      const [projects, recent, running] = await Promise.all([hubApi.projects(remoteId), hubApi.recent(remoteId), hubApi.running(remoteId)]);
      if (generation.current !== version) return;
      const needed = Math.min(latestStates.current[remoteId]?.conversations.length ?? 100, recent.total ?? 0);
      while (recent.conversations.length < needed && recent.hasMore) {
        const next = await hubApi.recent(remoteId, recent.conversations.length);
        if (!next.conversations?.length) break;
        recent.conversations.push(...next.conversations);
        recent.hasMore = next.hasMore;
      }
      if (generation.current !== version) return;
      setStates(current => ({
        ...current,
        [remoteId]: {
          status: 'online',
          projects,
          conversations: (recent.conversations ?? []).map((row: Record<string, unknown>) => normalizeConversation(remoteId, row)),
          total: recent.total ?? 0,
          running: (activityRevision.current.get(remoteId) ?? 0) !== snapshotRevision ? current[remoteId]?.running ?? [] : (running.sessions ?? []).map((s: { sessionId: string }) => s.sessionId),
          attention: getHubUnread(remoteId)
        }
      }));
    } catch (error) {
      if (generation.current === version) setStates(current => ({
        ...current,
        [remoteId]: {
          ...(current[remoteId] ?? initial()),
          status: error instanceof Error && error.message === 'LOGIN_REQUIRED' ? 'login' : 'offline',
          error: error instanceof Error ? error.message : '连接失败'
        }
      }));
    } finally {
      if (busy.current.get(remoteId) === version) busy.current.delete(remoteId);
    }
  }, []);
  useEffect(() => {
    const version = ++generation.current;
    const refreshAll = () => remotes.forEach(remote => {
      void refresh(remote.id);
    });
    refreshAll();
    const timer = window.setInterval(refreshAll, 10000);
    window.addEventListener('focus', refreshAll);
    const syncUnread = () => setStates(current => Object.fromEntries(Object.entries(current).map(([id, state]) => [id, { ...state, attention: getHubUnread(id) }])));
    window.addEventListener('storage', syncUnread);
    window.addEventListener('storage', refreshAll);
    return () => {
      generation.current = version + 1;
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshAll);
      window.removeEventListener('storage', syncUnread);
      window.removeEventListener('storage', refreshAll);
    };
  }, [remotes, refresh]);
  const tokenSignature = remotes.map(remote => remoteToken(remote.id)).join('|');
  useEffect(() => {
    let closed = false;
    const sockets = new Set<WebSocket>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    for (const remote of remotes) {
      const token = remoteToken(remote.id);
      if (!token) continue;
      const connect = () => {
        if (closed) return;
        const socket = new WebSocket(hubApi.socketUrl(remote.id, token));
        sockets.add(socket);
        socket.onopen = () => {
          void refresh(remote.id);
        };
        // Metadata observer only: chat.subscribe would reattach the runtime's
        // writer and steal streaming output from the actual conversation pane.
        socket.onmessage = event => {
          try {
            const message = JSON.parse(event.data);
            if (message.kind === 'session_activity' && typeof message.sessionId === 'string' && ['running', 'complete', 'error', 'permission'].includes(message.status)) {
              activityRevision.current.set(remote.id, (activityRevision.current.get(remote.id) ?? 0) + 1);
              setStates(current => {
                const previous = current[remote.id] ?? initial();
                const running = new Set(previous.running);
                const attention = message.status === 'running' ? previous.attention : recordHubUnread(remote.id, message.sessionId, String(message.eventId ?? `${message.runId}:${message.status}:${message.seq}`));
                if (message.status === 'running' || message.status === 'permission') running.add(message.sessionId);
                else running.delete(message.sessionId);

                return { ...current, [remote.id]: { ...previous, running: [...running], attention } };
              });
            }
            if (['session_upserted', 'session_activity', 'session_context_reset', 'session_deleted', 'projects_updated'].includes(message.kind)) void refresh(remote.id);
            if (message.kind === 'session_activity' && typeof message.sessionId === 'string' && typeof message.eventId === 'string' && ['complete', 'error', 'permission'].includes(message.status)) {
              const key = `${remote.id}:${message.eventId}`;
              if (!notificationKeys.current.has(key)) {
                notificationKeys.current.add(key);
                if (notificationKeys.current.size > 1000) notificationKeys.current.delete(notificationKeys.current.values().next().value!);
                notifyRef.current(remote.id, message.sessionId, message.status === 'complete' ? '已完成' : message.status === 'permission' ? '等待确认' : '出现错误');
              }
            }
          } catch {/* Ignore non-JSON transport messages. */}
        };
        socket.onclose = () => {
          sockets.delete(socket);
          if (!closed) {
            const timer = setTimeout(() => {
              timers.delete(timer);
              connect();
            }, 4000);
            timers.add(timer);
          }
        };
        socket.onerror = () => socket.close();
      };
      connect();
    }
    return () => {
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.close();
    };
  }, [remotes, refresh, tokenSignature]);
  const markRead = useCallback((remoteId: string, sessionId: string) => {
    readHubConversation(remoteId, sessionId);
    setStates(current => current[remoteId]?.attention.includes(sessionId) ? { ...current, [remoteId]: { ...current[remoteId], attention: current[remoteId].attention.filter(id => id !== sessionId) } } : current);
  }, []);
  return {
    markRead,
    states,
    refresh,
    setStates
  };
}
