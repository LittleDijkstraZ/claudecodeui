import { useCallback, useEffect, useRef, useState } from 'react';

import { getLocalChatBackups, hubApi, remoteToken, saveLocalChatBackup, saveLocalChatBackupObservations, setLocalChatBackupSettings } from '@/shared/api';
import type { ChatBackupScope, ChatBackupSessionSnapshot, HubGroupState, HubRemote, HubRemoteState, LocalChatBackupStatus } from '@/shared/types';

/** Used by the remote Hub and backup dialog to track selected chats and their organization only after opt-in. */
export function useLocalChatBackupSync(remotes: HubRemote[], groups: HubGroupState, states: Record<string, HubRemoteState>) {
  // The local inventory retains native content watermarks separately from observed metadata.
  const [status, setStatus] = useState<LocalChatBackupStatus | null>(null);
  // Retain actionable fetch/save failures without affecting remote chat connections.
  const [error, setError] = useState<string | null>(null);
  // Keep manual, change-driven and periodic synchronization from overlapping.
  const [syncing, setSyncing] = useState(false);
  // Show progress while checking and copying a potentially large initial inventory.
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const inputs = useRef({ remotes, groups, states });
  const statusRef = useRef<LocalChatBackupStatus | null>(null);
  const activeSync = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const settingsRequest = useRef(0);
  const rerunRequested = useRef(false);
  const mounted = useRef(false);
  const latestSync = useRef<() => Promise<void>>(async () => {});
  useEffect(() => { inputs.current = { remotes, groups, states }; }, [remotes, groups, states]);

  const applyStatus = useCallback((next: LocalChatBackupStatus) => {
    if (!mounted.current) return;
    const previous = statusRef.current;
    statusRef.current = next;
    setStatus(next);
    if (!next.enabled || (previous && previous.settingsRevision !== next.settingsRevision)) {
      activeSync.current?.abort();
      if (next.enabled && activeSync.current) rerunRequested.current = true;
    }
  }, []);

  const refresh = useCallback(async () => {
    const request = settingsRequest.current;
    const next = await getLocalChatBackups();
    // A read begun before an explicit settings change cannot undo that choice.
    if (request === settingsRequest.current && mounted.current) {
      applyStatus(next);
      setError(null);
    }
  }, [applyStatus]);

  const syncNow = useCallback(async (): Promise<void> => {
    if (!mounted.current) return;
    if (busy.current) { rerunRequested.current = true; return; }
    busy.current = true;
    const controller = new AbortController();
    activeSync.current = controller;
    try {
      await refresh();
      const setting = statusRef.current;
      if (!setting?.enabled || controller.signal.aborted) return;
      const source = inputs.current;
      const revision = setting.settingsRevision;
      const valid = () => !controller.signal.aborted && mounted.current && statusRef.current?.enabled === true && statusRef.current.settingsRevision === revision;
      const signal = () => AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]);
      setSyncing(true);
      setProgress({ completed: 0, total: 0 });
      setError(null);
      const saved = new Map(setting.backups.map(backup => [`${backup.remoteId}:${backup.sessionId}`, backup]));
      const failures: string[] = [];
      let completed = 0;
      let total = 0;
      // This also captures empty groups and changed membership. Missing/offline
      // observations are merged on disk, never interpreted as a deleted chat.
      const observe = async (remote: HubRemote | null, rows: ChatBackupSessionSnapshot[]) => {
        if (!valid()) return;
        const next = await saveLocalChatBackupObservations({
          settingsRevision: revision,
          observations: remote ? rows.map(row => ({
            ...row, remoteId: remote.id, remoteName: remote.name, observedAt: new Date().toISOString(),
            attention: source.states[remote.id]?.status === 'online' ? source.states[remote.id].attention.includes(row.sessionId) : null,
          })) : [],
        }, signal());
        if (valid()) applyStatus(next);
      };
      await observe(null, []);
      for (const remote of source.remotes) {
        if (!valid()) break;
        const inScope = (sessionId: string) => setting.scope === 'all' || inputs.current.groups.groups.some(group => group.members.some(member => member.remoteId === remote.id && member.sessionId === sessionId));
        const memberIds = [...new Set(source.groups.groups.flatMap(group => group.members.filter(member => member.remoteId === remote.id).map(member => member.sessionId)))];
        if (setting.scope === 'grouped' && memberIds.length === 0) continue;
        if (!remoteToken(remote.id)) { failures.push(`${remote.name}：登录后才能备份`); continue; }
        const seen = new Set<string>();
        const cursors = new Set<string>();
        let cursor: string | undefined;
        let offset = 0;
        try {
          do {
            if (!valid()) break;
            const request = setting.scope === 'grouped' ? { sessionIds: memberIds.slice(offset, offset + 500) } : { cursor, limit: 100 };
            const page = await hubApi.chatBackupInventory(remote.id, request, signal());
            if (!valid()) break;
            if (!Array.isArray(page.sessions)) throw new Error('会话清单无效');
            const rows = page.sessions.filter(row => !seen.has(row.sessionId));
            page.sessions.forEach(row => seen.add(row.sessionId));
            if (page.sessions.length > 0 && rows.length === 0) throw new Error('会话分页重复，请重试');
            if (page.missingSessionIds.length) failures.push(`${remote.name}：${page.missingSessionIds.length} 个分组成员暂不可读取，已有记录已保留`);
            total += rows.length;
            setProgress({ completed, total });
            await observe(remote, rows);
            for (const row of rows) {
              if (!valid()) break;
              const previous = saved.get(`${remote.id}:${row.sessionId}`);
              try {
                // Empty drafts and unsupported providers still have useful group,
                // title and state metadata, but no native transcript to export.
                if (inScope(row.sessionId) && row.history === 'native' && (row.provider === 'claude' || row.provider === 'codex')
                  && (!previous || !row.contentVersion || previous.contentVersion !== row.contentVersion)) {
                  const bundle = await hubApi.exportChatBackup(remote.id, row.sessionId, signal());
                  if (!valid()) break;
                  // Membership can change while another transcript is being read.
                  if (inScope(row.sessionId)) {
                    const result = await saveLocalChatBackup({ remoteId: remote.id, remoteName: remote.name,
                      sourceUpdatedAt: row.updatedAt, contentVersion: row.contentVersion, settingsRevision: revision, bundle }, signal());
                    saved.set(`${remote.id}:${row.sessionId}`, result.backup);
                  }
                }
              } catch (cause) {
                if (!valid()) break;
                failures.push(`${remote.name} · ${row.title}：${cause instanceof Error ? cause.message : '备份失败'}`);
              }
              completed += 1;
              setProgress({ completed, total });
            }
            if (setting.scope === 'grouped') {
              offset += 500;
              if (offset >= memberIds.length) break;
            } else {
              if (!page.nextCursor) break;
              if (cursors.has(page.nextCursor)) throw new Error('会话分页重复，请重试');
              cursors.add(page.nextCursor);
              cursor = page.nextCursor;
            }
          } while (valid());
        } catch (cause) {
          if (valid()) failures.push(`${remote.name}：${cause instanceof Error ? cause.message : '连接失败'}`);
        }
      }
      if (valid()) {
        await refresh();
        if (valid()) setError(failures.length ? failures.slice(0, 5).join('\n') + (failures.length > 5 ? `\n另有 ${failures.length - 5} 项未完成，下次同步会重试。` : '') : null);
      }
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current) setError(cause instanceof Error ? cause.message : '无法读取本地备份设置');
    } finally {
      if (activeSync.current === controller) activeSync.current = null;
      busy.current = false;
      if (mounted.current) setSyncing(false);
      if (mounted.current && rerunRequested.current) {
        rerunRequested.current = false;
        void latestSync.current();
      }
    }
  }, [applyStatus, refresh]);

  const updateSettings = useCallback(async (patch: { enabled?: boolean; scope?: ChatBackupScope }) => {
    const revision = statusRef.current?.settingsRevision;
    if (revision === undefined) throw new Error('请先读取本地备份设置');
    const request = ++settingsRequest.current;
    activeSync.current?.abort();
    try {
      const next = await setLocalChatBackupSettings({ ...patch, settingsRevision: revision });
      if (request !== settingsRequest.current || !mounted.current) return;
      applyStatus(next);
      setError(null);
      if (next.enabled) void syncNow();
    } catch (cause) {
      // Another window may have disabled sync. Read its current setting, never
      // replay a stale enable/scope patch after a rejected compare-and-swap.
      if (request === settingsRequest.current && mounted.current) {
        try { await refresh(); } catch { /* Preserve the original setting error. */ }
      }
      throw cause;
    }
  }, [applyStatus, refresh, syncNow]);
  const setEnabled = useCallback((enabled: boolean) => updateSettings({ enabled }), [updateSettings]);
  const setScope = useCallback((scope: ChatBackupScope) => updateSettings({ scope }), [updateSettings]);

  useEffect(() => {
    mounted.current = true;
    latestSync.current = syncNow;
    // eslint-disable-next-line react/set-state-in-effect -- The persisted opt-in is read before any remote content request.
    void syncNow();
    const timer = window.setInterval(() => { void syncNow(); }, 60_000);
    return () => {
      window.clearInterval(timer);
      mounted.current = false;
      rerunRequested.current = false;
      activeSync.current?.abort();
    };
  }, [syncNow]);

  // Hub polling replaces state objects every ten seconds. Compare meaningful
  // metadata so identical polls do not trigger another full inventory scan.
  const dirtySignature = JSON.stringify([remotes.map(remote => [remote.id, remote.name]), groups.revision, groups.groups,
    remotes.map(remote => {
      const state = states[remote.id];
      return state ? [remote.id, state.status, [...state.running].sort(), [...state.attention].sort(),
        state.conversations.map(row => [row.sessionId, row.title, row.projectPath, row.provider, row.lastActivity, row.isArchived]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))] : [remote.id];
    })]);
  useEffect(() => {
    if (!statusRef.current?.enabled) return;
    const timer = window.setTimeout(() => { void syncNow(); }, 750);
    return () => window.clearTimeout(timer);
  }, [dirtySignature, syncNow]);

  return { status, error, syncing, progress, refresh, setEnabled, setScope, syncNow };
}
