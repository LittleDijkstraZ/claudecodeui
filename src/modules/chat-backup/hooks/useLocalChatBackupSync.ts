import { useCallback, useEffect, useRef, useState } from 'react';

import { getLocalChatBackups, hubApi, remoteToken, saveLocalChatBackup, setLocalChatBackupEnabled } from '@/shared/api';
import type { HubRemote, LocalChatBackupStatus } from '@/shared/types';

/** Used by the remote Hub and backup dialog to copy native chats to this computer only after opt-in. */
export function useLocalChatBackupSync(remotes: HubRemote[]) {
  // The local disk inventory drives the dialog and incremental source watermarks.
  const [status, setStatus] = useState<LocalChatBackupStatus | null>(null);
  // Retain actionable fetch/save failures without affecting remote chat connections.
  const [error, setError] = useState<string | null>(null);
  // Keep manual and periodic synchronization from running concurrently.
  const [syncing, setSyncing] = useState(false);
  // Show progress while paginating and copying a potentially large initial inventory.
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const statusRef = useRef<LocalChatBackupStatus | null>(null);
  const activeSync = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const settingsRevision = useRef(0);
  // A toggle or remote-list change arriving during a request must trigger another pass immediately.
  const rerunRequested = useRef(false);
  const mounted = useRef(false);
  const latestSync = useRef<() => Promise<void>>(async () => {});

  const applyStatus = useCallback((next: LocalChatBackupStatus) => {
    statusRef.current = next;
    setStatus(next);
    if (!next.enabled) activeSync.current?.abort();
  }, []);

  const refresh = useCallback(async () => {
    const revision = settingsRevision.current;
    const next = await getLocalChatBackups();
    // A status request started before a toggle cannot undo that explicit choice.
    if (revision === settingsRevision.current) {
      applyStatus(next);
      setError(null);
    }
  }, [applyStatus]);

  const syncNow = useCallback(async (): Promise<void> => {
    if (busy.current) { rerunRequested.current = true; return; }
    busy.current = true;
    const controller = new AbortController();
    activeSync.current = controller;
    try {
      await refresh();
      if (!statusRef.current?.enabled || controller.signal.aborted) return;
      setSyncing(true);
      setError(null);
      const saved = new Map(statusRef.current.backups.map(backup => [`${backup.remoteId}:${backup.sessionId}`, backup]));
      const failures: string[] = [];
      let completed = 0;
      let total = 0;
      const signal = () => AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]);
      for (const remote of remotes) {
        if (controller.signal.aborted) break;
        if (!remoteToken(remote.id)) {
          failures.push(`${remote.name}：登录后才能备份`);
          continue;
        }
        let offset = 0;
        const seen = new Set<string>();
        try {
          while (!controller.signal.aborted) {
            const page = await hubApi.recent(remote.id, offset, { signal: signal() });
            if (!Array.isArray(page.conversations)) throw new Error('会话列表无效');
            const rows = page.conversations as Array<{ sessionId: string; provider: string; lastActivity?: string | null }>;
            if (rows.length === 0) break;
            // Stop a broken pagination endpoint from repeating the same page forever.
            if (rows.every(row => seen.has(row.sessionId))) throw new Error('会话分页重复，请重试');
            const supported = rows.filter(row => !seen.has(row.sessionId) && (row.provider === 'claude' || row.provider === 'codex'));
            rows.forEach(row => seen.add(row.sessionId));
            total += supported.length;
            setProgress({ completed, total });
            for (const row of supported) {
              if (controller.signal.aborted) break;
              const previous = saved.get(`${remote.id}:${row.sessionId}`);
              const sourceUpdatedAt = row.lastActivity ?? null;
              try {
                // Unknown timestamps are rechecked; a transient failure never advances this watermark.
                if (!previous || !sourceUpdatedAt || previous.sourceUpdatedAt !== sourceUpdatedAt) {
                  const bundle = await hubApi.exportChatBackup(remote.id, row.sessionId, signal());
                  if (controller.signal.aborted || !statusRef.current?.enabled) break;
                  const result = await saveLocalChatBackup({ remoteId: remote.id, remoteName: remote.name, sourceUpdatedAt, bundle }, signal());
                  saved.set(`${remote.id}:${row.sessionId}`, result.backup);
                }
              } catch (cause) {
                if (controller.signal.aborted) break;
                failures.push(`${remote.name} · ${row.sessionId}：${cause instanceof Error ? cause.message : '备份失败'}`);
              }
              completed += 1;
              setProgress({ completed, total });
            }
            offset += rows.length;
            if (page.hasMore === false || (typeof page.total === 'number' && offset >= page.total) || rows.length < 100) break;
          }
        } catch (cause) {
          if (!controller.signal.aborted) failures.push(`${remote.name}：${cause instanceof Error ? cause.message : '连接失败'}`);
        }
      }
      if (!controller.signal.aborted) {
        await refresh();
        setError(failures.length ? failures.slice(0, 5).join('\n') + (failures.length > 5 ? `\n另有 ${failures.length - 5} 个会话未完成，下次同步会重试。` : '') : null);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '无法读取本地备份设置');
    } finally {
      if (activeSync.current === controller) activeSync.current = null;
      busy.current = false;
      setSyncing(false);
      if (mounted.current && rerunRequested.current) {
        rerunRequested.current = false;
        void latestSync.current();
      }
    }
  }, [refresh, remotes]);

  const setEnabled = useCallback(async (enabled: boolean) => {
    settingsRevision.current += 1;
    if (!enabled) activeSync.current?.abort();
    const next = await setLocalChatBackupEnabled(enabled);
    applyStatus(next);
    setError(null);
    if (enabled) void syncNow();
  }, [applyStatus, syncNow]);

  useEffect(() => {
    mounted.current = true;
    latestSync.current = syncNow;
    // eslint-disable-next-line react/set-state-in-effect -- Synchronizes the external Hub disk store; state updates follow awaited requests.
    void syncNow();
    // Periodic inventory scans also discover chats that have never been opened in this Hub.
    const timer = window.setInterval(() => { void syncNow(); }, 60_000);
    return () => {
      window.clearInterval(timer);
      mounted.current = false;
      rerunRequested.current = false;
      activeSync.current?.abort();
    };
  }, [syncNow]);

  return { status, error, syncing, progress, refresh, setEnabled, syncNow };
}
