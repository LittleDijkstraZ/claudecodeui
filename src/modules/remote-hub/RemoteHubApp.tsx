import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, HardDriveDownload, Mail, GitFork, GripVertical, Pencil, ChevronDown, ChevronRight, ExternalLink, Folder, Layers, MoreHorizontal, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Pin, Plus, RefreshCw, Server, Settings, Trash2, X } from 'lucide-react';

import { HubDialog } from '@/modules/remote-hub/modals/HubDialog';
import { HubConversationDialog } from '@/modules/remote-hub/modals/HubConversationDialog';
import { HubWorkspaceToolbar } from '@/modules/remote-hub/HubWorkspaceToolbar';
import { useHubPanes } from '@/modules/remote-hub/hooks/useHubPanes';
import { useHubSidebar } from '@/modules/remote-hub/hooks/useHubSidebar';
import { changeHubGroups, loadHubGroups, hubApi } from '@/shared/api';
import type { HubRemote, HubConversation, HubGroup, HubGroupState, HubDialogState, HubConversationAction } from '@/shared/types';
import { ThemeProvider } from '@/shared/context/ThemeContext';
import { SessionAttentionIndicator, SessionRunningIndicator, ActionMenu, Button, Input } from '@/shared/ui';
import { LocalChatBackupsDialog, useLocalChatBackupSync } from '@/modules/chat-backup';
import { useConversationGroupDrag } from '@/modules/sidebar';
import { memberKey, moveHubGroup, moveHubMember, normalizeConversation } from '@/modules/remote-hub/utils/hubClient';
import { useHubConnections } from '@/modules/remote-hub/hooks/useHubConnections';
const emptyGroups: HubGroupState = {
  revision: 0,
  groups: [],
  imported: []
};
function Hub() {
  // Registered SSH tunnel destinations populate the machine picker.
  const [remotes, setRemotes] = useState<HubRemote[]>([]);
  // The local backup dialog is independent of the settings inside each remote pane.
  const [showChatBackups, setShowChatBackups] = useState(false);
  // The latest revision of local cross-machine groups is shared across windows.
  const [groups, setGroups] = useState<HubGroupState>(emptyGroups);
  // A visible failure is retained until the user retries or dismisses it.
  const [error, setError] = useState('');
  // Locks group controls while an ordered metadata mutation is pending.
  const [saving, setSaving] = useState(false);
  // Retains the chosen sidebar view without changing the active conversation.
  const [mode, setMode] = useState<'groups' | 'projects' | 'recent' | 'running'>('groups');
  // Stores independently expanded groups and project folders.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Filters sidebar rows without losing their saved order.
  const [query, setQuery] = useState('');
  // Identifies the remote conversation displayed in the main pane.
  const [selection, setSelection] = useState<HubConversation | null>(null);
  // Allows login to a machine before any conversation is selected.
  const [loginRemote, setLoginRemote] = useState<string | null>(null);
  const { chatVisibility, acceptChatVisibility, navigation, selections, acceptNavigation, selectTab, panes, navigate: navigatePane, register: registerPane, remoteForSource, markReady, acceptSelection, openSettings, acceptSettingsOpened, panelStates, setPanelOpen, acceptPanelState } = useHubPanes();
  // Retains the current group or conversation dialog operation.
  const [modal, setModal] = useState<HubDialogState | null>(null);
  // Keeps remote conversation operations separate from local group dialogs.
  const [conversationAction, setConversationAction] = useState<HubConversationAction | null>(null);
  // A background tab must not mark its retained conversation as read.
  const [pageVisible, setPageVisible] = useState(document.visibilityState !== 'hidden');
  useEffect(() => {
    const changed = () => setPageVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  const sidebar = useHubSidebar();
  const { sidebarOpen, setSidebarOpen } = sidebar;
  // Keep machine preferences reachable while a visited remote serves the previous drawer protocol.
  const [fallbackToolsRemote, setFallbackToolsRemote] = useState<string | null>(null);
  // Controls the retained cross-machine notification inbox.
  const [showNotifications, setShowNotifications] = useState(false);
  // Retains completion and attention notices independently of the selected machine.
  const [notifications, setNotifications] = useState<Array<{
    id: string;
    remoteId: string;
    sessionId: string;
    label: string;
    seen: boolean;
  }>>([]);
  // Scopes a detached window to one group until the user expands its scope.
  const [groupWindow, setGroupWindow] = useState(new URLSearchParams(window.location.search).get('group'));
  const importBusy = useRef(new Set<string>());
  const groupChannel = useRef<BroadcastChannel | null>(null);
  const onNotification = useCallback((remoteId: string, sessionId: string, label: string) => {
    setNotifications(current => [{
      id: crypto.randomUUID(),
      remoteId,
      sessionId,
      label,
      seen: false
    }, ...current].slice(0, 50));
  }, []);
  const {
    states,
    refresh,
    setStates,
    markRead,
    markUnread
  } = useHubConnections(remotes, onNotification);
  const backupSync = useLocalChatBackupSync(remotes, groups, states);
  // Retains loaded project pages across sidebar view changes.
  const [projectRows, setProjectRows] = useState<Record<string, HubConversation[]>>({});
  // Displays pending page loads independently for each remote project.
  const [loadingRows, setLoadingRows] = useState<Set<string>>(new Set());
  const projectLoads = useRef(new Set<string>());
  useEffect(() => {
    if (!selection || !pageVisible || selections[selection.remoteId] !== selection.sessionId) return;
    if (sidebar.narrow && (sidebarOpen || fallbackToolsRemote === selection.remoteId)) return;
    const visible = chatVisibility[selection.remoteId];
    if (visible && (visible.sessionId !== selection.sessionId || !visible.visible)) return;
    if (states[selection.remoteId]?.attention.includes(selection.sessionId)) markRead(selection.remoteId, selection.sessionId, true);
  }, [selection, selections, chatVisibility, pageVisible, states, markRead, sidebar.narrow, sidebarOpen, fallbackToolsRemote]);
  const allConversations = useMemo(() => Object.values(states).flatMap(s => s.conversations), [states]);
  const byKey = useMemo(() => new Map(allConversations.map(c => [memberKey(c), c])), [allConversations]);
  const resolvedMember = (member: HubConversation) => byKey.get(memberKey(member)) ?? member;
  const filtered = (member: HubConversation) => `${member.title} ${member.projectPath} ${remotes.find(r => r.id === member.remoteId)?.name}`.toLowerCase().includes(query.toLowerCase());
  const selectedRemote = remotes.find(r => r.id === (selection?.remoteId ?? loginRemote));
  const selectedPanel = selectedRemote ? panelStates[selectedRemote.id] : undefined;
  const rightPanelOpen = selectedPanel ? selectedPanel.pendingOpen ?? selectedPanel.open : fallbackToolsRemote === selectedRemote?.id;
  useEffect(() => {
    if (!fallbackToolsRemote || !panelStates[fallbackToolsRemote]) return;
    setPanelOpen(fallbackToolsRemote, true);
    setFallbackToolsRemote(null);
  }, [fallbackToolsRemote, panelStates, setPanelOpen]);
  const toggleRightPanel = () => {
    if (!selectedRemote) return;
    if (selectedPanel) setPanelOpen(selectedRemote.id, !rightPanelOpen);
    else setFallbackToolsRemote(rightPanelOpen ? null : selectedRemote.id);
  };
  useEffect(() => {
    void hubApi.config().then(data => setRemotes(data.remotes)).catch(() => setError('无法读取连接配置'));
    const reload = () => {
      void loadHubGroups().then(state => setGroups(current => state.revision >= current.revision ? state : current)).catch(cause => setError(String(cause)));
    };
    reload();
    const channel = new BroadcastChannel('cloudcli-hub-groups');
    groupChannel.current = channel;
    channel.onmessage = reload;
    window.addEventListener('focus', reload);
    return () => {
      channel.close();
      window.removeEventListener('focus', reload);
    };
  }, []);
  const update = useCallback(async (operation: (state: HubGroupState) => HubGroupState) => {
    setSaving(true);
    setError('');
    try {
      const state = await changeHubGroups(operation);
      setGroups(current => state.revision >= current.revision ? state : current);
      groupChannel.current?.postMessage('changed');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败');
      throw cause;
    } finally {
      setSaving(false);
    }
  }, []);
  const onMove = useCallback(async (groupId: string, source: string, target: string, position: 'before' | 'after') => {
    await update(state => moveHubMember(state, groupId, source, target, position));
  }, [update]);
  const drag = useConversationGroupDrag({
    onMove,
    disabled: saving,
    onError: () => {}
  });
  const onMoveGroup = useCallback(async (_scope: string, source: string, target: string, position: 'before' | 'after') => {
    await update(state => moveHubGroup(state, source, target, position));
  }, [update]);
  const groupDrag = useConversationGroupDrag({
    onMove: onMoveGroup,
    disabled: saving || Boolean(groupWindow) || drag.isMoving || Boolean(drag.dragState),
    onError: () => {}, // The shared update path already displays storage failures.
    targetSelector: '[data-hub-sort-group]',
    targetIdentity: element => ({ groupId: element.dataset.hubSortScope ?? '', sessionId: element.dataset.hubSortGroup ?? '' }),
  });
  const expand = (id: string) => setExpanded(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);else next.add(id);
    return next;
  });
  const openMember = (member: HubConversation) => {
    markRead(member.remoteId, member.sessionId);
    setSelection(resolvedMember(member));
    setLoginRemote(null);
    navigatePane(member.remoteId, member.sessionId);
    if (sidebar.narrow) setSidebarOpen(false);
    const url = new URL(window.location.href);
    url.searchParams.set('remote', member.remoteId);
    url.searchParams.set('session', member.sessionId);
    history.replaceState(null, '', url);
  };
  useEffect(() => {
    if (selection || loginRemote) return;
    const params = new URLSearchParams(window.location.search),
      id = params.get('session'),
      remoteId = params.get('remote');
    const fromLink = allConversations.find(c => c.sessionId === id && c.remoteId === remoteId);
    const fromGroup = groups.groups.find(g => g.id === groupWindow)?.members[0];
    if (fromLink || fromGroup) { const member=fromLink??fromGroup!; setSelection(member); navigatePane(member.remoteId, member.sessionId); }
  }, [allConversations, groups, groupWindow, selection, loginRemote, navigatePane]);
  useEffect(() => {
    const message = (event: MessageEvent) => {
      if (event.origin !== location.origin) return;
      const remoteId = remoteForSource(event.source);
      if (!remoteId) return;
      if (event.data?.kind === 'cloudcli:ready') { markReady(remoteId); return; }
      if (event.data?.kind === 'cloudcli:settings-opened') { if (event.data.remoteId === remoteId) acceptSettingsOpened(remoteId, event.data.requestId); return; }
      if (event.data?.kind === 'cloudcli:workspace-panel-state') { acceptPanelState(remoteId, event.data); return; }
      if (event.data?.kind === 'cloudcli:chat-visibility') { acceptChatVisibility(remoteId, event.data); return; }
      if (event.data?.kind === 'cloudcli:workspace-nav') { acceptNavigation(remoteId, event.data); return; }
      if (event.data?.kind !== 'cloudcli:selection' || typeof event.data.sessionId !== 'string') return;
      if (remoteId !== (selection?.remoteId ?? loginRemote) || !acceptSelection(remoteId, event.data.sessionId)) return;
      const next = {
        remoteId,
        sessionId: event.data.sessionId,
        title: event.data.title,
        projectId: event.data.projectId,
        projectPath: event.data.projectPath,
        provider: event.data.provider
      };
      setSelection(current => current && current.remoteId === next.remoteId && current.sessionId === next.sessionId && current.title === next.title && current.projectId === next.projectId ? current : next);
      setLoginRemote(null);
      const url = new URL(location.href); url.searchParams.set('remote', remoteId); url.searchParams.set('session', next.sessionId); history.replaceState(null, '', url);
    };
    window.addEventListener('message', message);
    return () => window.removeEventListener('message', message);
  }, [selection?.remoteId, loginRemote, remoteForSource, markReady, acceptSettingsOpened, acceptPanelState, acceptSelection, acceptNavigation, acceptChatVisibility]);
  // Import each remote user's existing groups once. Membership order is fetched
  // from that remote in pages, then becomes independent local hub metadata.
  useEffect(() => {
    for (const remote of remotes) {
      if (states[remote.id]?.status !== 'online' || importBusy.current.has(remote.id)) continue;
      importBusy.current.add(remote.id);
      void (async () => {
        const user = await hubApi.user(remote.id);
        const importId = `${remote.id}:${user.user?.id ?? user.id ?? 'user'}`;
        const current = await loadHubGroups();
        if (current.imported.includes(importId)) return;
        const snapshot = await hubApi.groups(remote.id);
        const imported: HubGroup[] = [];
        for (const group of snapshot.groups ?? []) {
          const members: HubConversation[] = [];
          let offset = 0,
            hasMore = true;
          while (hasMore) {
            const page = await hubApi.groupConversations(remote.id, group.id, offset);
            members.push(...page.conversations.map((row: Record<string, unknown>) => normalizeConversation(remote.id, row)));
            offset += page.conversations.length;
            hasMore = Boolean(page.hasMore && page.conversations.length);
          }
          imported.push({
            id: `import-${remote.id}-${group.id}`,
            name: group.name,
            isPinned: Boolean(group.isPinned),
            members
          });
        }
        await update(state => {
          if (state.imported.includes(importId)) return state;
          const existing = new Set(state.groups.flatMap(g => g.members.map(memberKey)));
          state.groups.push(...imported.map(g => ({
            ...g,
            members: g.members.filter(m => !existing.has(memberKey(m)))
          })));
          state.imported.push(importId);
          return state;
        });
      })().catch(() => {
        importBusy.current.delete(remote.id);
      });
    }
  }, [remotes, states, update]);
  const loadProject = async (remoteId: string, projectId: string, more = false, preserveDepth = false) => {
    const key = `${remoteId}:${projectId}`;
    if (projectLoads.current.has(key)) return;
    projectLoads.current.add(key);
    setLoadingRows(current => new Set(current).add(key));
    try {
      const offset = more ? projectRows[key]?.length ?? 0 : 0;
      const data = await hubApi.projectSessions(remoteId, projectId, offset);
      const project = states[remoteId].projects.find(p => p.projectId === projectId);
      const loaded = Array.isArray(data) ? data : data.sessions ?? [];
      const needed = preserveDepth ? projectRows[key]?.length ?? 100 : 0;
      while (loaded.length < needed && loaded.length < (project?.sessionMeta?.total ?? 0)) {
        const next = await hubApi.projectSessions(remoteId, projectId, loaded.length);
        const rows = Array.isArray(next) ? next : next.sessions ?? [];
        if (!rows.length) break;
        loaded.push(...rows);
      }
      const rows = loaded.map((s: Record<string, unknown>) => normalizeConversation(remoteId, {
        ...s,
        projectId,
        projectPath: project?.fullPath
      }));
      setProjectRows(current => ({
        ...current,
        [key]: more ? [...(current[key] ?? []), ...rows] : rows
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载失败');
    } finally {
      projectLoads.current.delete(key);
      setLoadingRows(current => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };
  useEffect(() => {
    for (const remote of remotes) {
      if (states[remote.id]?.status !== 'online') continue;
      for (const project of states[remote.id].projects) {
        const key = `${remote.id}:${project.projectId}`;
        if (expanded.has(key) && projectRows[key]) void loadProject(remote.id, project.projectId, false, true);
      }
    }
    // Refresh cached expanded pages only when the remote snapshot changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [states]);
  const assign = async (member: HubConversation, groupId: string | null) => update(state => {
    if (state.groups.find(g => g.members.some(m => memberKey(m) === memberKey(member)))?.id === groupId) return state;
    state.groups.forEach(g => {
      g.members = g.members.filter(m => memberKey(m) !== memberKey(member));
    });
    if (groupId) {
      const target = state.groups.find(g => g.id === groupId);
      if (!target) throw new Error('目标分组已不存在');
      target.members.push(member);
    }
    return state;
  });
  const renderRow = (raw: HubConversation, group?: HubGroup, index = 0) => {
    const member = resolvedMember(raw),
      key = memberKey(member),
      status = states[member.remoteId]?.status;
    const running = Boolean(states[member.remoteId]?.running.includes(member.sessionId));
    const attention = Boolean(states[member.remoteId]?.attention.includes(member.sessionId));
    const before = group?.members[index - 1],
      after = group?.members[index + 1];
    const target = drag.dropTarget?.sessionId === key ? drag.dropTarget.position : null;
    return <div key={key} data-testid="hub-conversation-row" data-group-id={group?.id} data-session-id={key} {...group ? drag.rowProps(group.id, key) : {}} className={`relative flex h-8 min-w-0 items-stretch rounded-md hover:bg-accent ${selection && memberKey(selection) === key ? 'bg-primary/10' : ''} ${drag.dragState?.sessionId === key ? 'opacity-50' : ''}`}>
      <SessionAttentionIndicator needsAttention={attention} className="pointer-events-none absolute left-0 top-1/2 -translate-x-1 -translate-y-1/2" />
      {target && <span className={`pointer-events-none absolute inset-x-0 h-0.5 bg-primary ${target === 'before' ? 'top-0' : 'bottom-0'}`} />}
      {group && <button {...drag.dragHandleProps(group.id, key)} disabled={saving} aria-label={`拖动 ${member.title}`} className="h-full w-6 shrink-0 cursor-grab rounded-l-md text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring">⋮</button>}
      <a href={`/?remote=${member.remoteId}&session=${member.sessionId}`} className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 text-[13px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring" title={`${member.title}\n${remotes.find(r => r.id === member.remoteId)?.name}\n${member.projectPath}`} onClick={e => {
        if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.defaultPrevented) return;
        e.preventDefault();
        openMember(member);
      }}>
        <span className="min-w-0 flex-1 truncate">{member.title}</span><SessionRunningIndicator isProcessing={running} /><span className={`max-w-16 truncate text-[10px] ${status === 'online' ? 'text-muted-foreground' : 'text-amber-600'}`}>{remotes.find(r => r.id === member.remoteId)?.name}</span>
      </a>
      <ActionMenu label="会话菜单" ariaLabel={`${member.title} 的菜单`} icon={MoreHorizontal} iconOnly portal variant="ghost" triggerClassName="h-8 w-8 shrink-0 p-0" disabled={saving} items={[{
        key: 'mark-unread', label: '标为未读', icon: Mail,
        onSelect: () => markUnread(member.remoteId, member.sessionId)
      }, {
        key: 'fork', label: 'Fork 对话', icon: GitFork, disabled: running || status !== 'online',
        description: running ? '本轮结束后可从完整对话创建分支' : undefined,
        onSelect: () => setConversationAction({ kind: 'fork', member, groupId: group?.id })
      }, {
        key: 'rename', label: '重命名', icon: Pencil, disabled: status !== 'online',
        onSelect: () => setConversationAction({ kind: 'rename', member })
      }, {
        key: 'assign',
        label: '移到分组',
        onSelect: () => setModal({
          kind: 'assign',
          member
        })
      }, ...(group ? [{
        key: 'remove',
        label: '移出分组',
        onSelect: () => {
          void assign(member, null).catch(() => {});
        }
      }, {
        key: 'up',
        label: '上移',
        disabled: !before,
        onSelect: () => {
          if (before) void onMove(group.id, key, memberKey(before), 'before').catch(() => {});
        }
      }, {
        key: 'down',
        label: '下移',
        disabled: !after,
        onSelect: () => {
          if (after) void onMove(group.id, key, memberKey(after), 'after').catch(() => {});
        }
      }] : []), {
        key: 'window',
        label: '在新窗口打开',
        icon: ExternalLink,
        onSelect: () => window.open(`/?remote=${member.remoteId}&session=${member.sessionId}`, '_blank', 'noopener')
      }, {
        key: 'delete', label: '删除对话', icon: Trash2, isDanger: true, showDividerBefore: true,
        disabled: running || status !== 'online', description: running ? '本轮结束后可删除' : undefined,
        onSelect: () => setConversationAction({ kind: 'delete', member })
      }]} />
    </div>;
  };
  const groupsToShow = [...groups.groups].sort((a, b) => Number(b.isPinned) - Number(a.isPinned)).filter(g => !groupWindow || g.id === groupWindow);

  return <div ref={sidebar.containerRef} className="fixed inset-0 flex bg-background text-foreground">
    {sidebarOpen && sidebar.narrow && <button type="button" aria-label="关闭侧栏遮罩" className="absolute inset-0 z-20 bg-background/50 backdrop-blur-[2px]" onClick={() => setSidebarOpen(false)} />}
    {sidebarOpen && <aside style={{ width: sidebar.width }} className={`${sidebar.narrow ? 'absolute inset-y-0 left-0' : 'relative shrink-0'} z-30 flex min-w-0 flex-col border-r border-border bg-[#f5f5f5] dark:bg-card`} data-testid="hub-sidebar">
      <div className="flex h-[52px] items-center gap-2 px-4"><Layers className="h-5 w-5 text-primary" /><strong className="flex-1">CloudCLI</strong><Button variant="ghost" size="icon" aria-label="本地聊天备份" title="本地聊天备份" onClick={() => setShowChatBackups(true)}><HardDriveDownload className="h-4 w-4" /></Button><Button variant="ghost" size="icon" aria-label="通知" onClick={() => {
          setShowNotifications(!showNotifications);
          setNotifications(items => items.map(n => ({
            ...n,
            seen: true
          })));
        }}><Bell className="h-4 w-4" />{notifications.some(n => !n.seen) && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}</Button><Button variant="ghost" size="icon" aria-label="收起左侧栏" title="收起左侧栏" className="h-9 w-9 shrink-0" onClick={() => setSidebarOpen(false)}><PanelLeftClose className="h-4 w-4" /></Button></div>
      <div className="space-y-1 px-3 pb-3">{remotes.map(remote => <div key={remote.id} className="flex items-center gap-2 text-xs"><span className={`h-1.5 w-1.5 rounded-full ${states[remote.id]?.status === 'online' ? 'bg-emerald-500' : states[remote.id]?.status === 'loading' ? 'bg-muted-foreground' : 'bg-amber-500'}`} /><span className="min-w-0 flex-1 truncate" title={remote.name}>{remote.name}</span><button className="rounded px-1.5 py-1 text-muted-foreground hover:bg-accent" onClick={() => {
            setLoginRemote(remote.id);
            setSelection(null);
            navigatePane(remote.id, null);
          }}>{states[remote.id]?.status === 'login' ? '登录' : states[remote.id]?.status === 'offline' ? '离线' : states[remote.id]?.status === 'online' ? '已连接' : '连接中'}</button><button aria-label={`刷新 ${remote.name}`} onClick={() => void refresh(remote.id)} className="p-1"><RefreshCw className="h-3 w-3" /></button></div>)}</div>
      <div aria-label="侧栏分类" className="mx-3 flex gap-1 rounded-lg bg-muted p-1">{([['groups', '分组'], ['projects', '项目'], ['recent', '最近'], ['running', '运行中']] as const).map(([id, label]) => <button key={id} type="button" aria-pressed={mode === id} onClick={() => setMode(id)} className={`min-h-8 min-w-0 flex-1 rounded-md px-1 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${mode === id ? 'bg-background shadow-sm' : 'hover:bg-background/60'}`}>{label}</button>)}</div>
      <div className="flex gap-2 p-3"><Input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索会话、文件夹或机器…" className="h-9 text-xs" /><Button size="icon" className="h-9 w-9 shrink-0" aria-label="新建对话" onClick={() => setModal({
          kind: 'new',
          groupId: groupWindow ?? undefined
        })}><Plus /></Button></div>
      {error && <div role="alert" className="mx-3 mb-2 rounded border border-destructive/30 p-2 text-xs text-destructive">{error}<button className="ml-2 underline" onClick={() => setError('')}>关闭</button></div>}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {mode === 'groups' && <><div className="mb-1 flex items-center justify-between px-1 text-xs text-muted-foreground"><span>{groupWindow ? '分组窗口' : '跨机器分组'}</span><button className="rounded p-1.5 hover:bg-accent" onClick={() => setModal({
              kind: 'group'
            })}>＋ 新建分组</button></div>{groupWindow && <button className="mb-2 text-xs text-primary" onClick={() => {
            setGroupWindow(null);
            history.replaceState(null, '', '/');
          }}>显示所有分组</button>}
        {groupsToShow.map(group => {
            const isOpen = expanded.has(group.id) || Boolean(query) || Boolean(groupWindow);
            const scope = group.isPinned ? 'pinned' : 'regular';
            const handle = groupDrag.dragHandleProps(scope, group.id);
            const drop = groupDrag.dropTarget?.sessionId === group.id ? groupDrag.dropTarget.position : null;
            const peers = groupsToShow.filter(other => other.isPinned === group.isPinned);
            const groupIndex = peers.findIndex(other => other.id === group.id);
            const previousGroup = peers[groupIndex - 1], nextGroup = peers[groupIndex + 1];
            const sortingDisabled = saving || Boolean(groupWindow) || groupDrag.isMoving;
            return <section key={group.id} data-testid="hub-group" data-group-id={group.id} data-hub-sort-group={group.id} data-hub-sort-scope={scope}
              className={`relative ${groupDrag.dragState?.sessionId === group.id ? 'opacity-50' : ''}`}>
          {drop && <div aria-hidden="true" className={`pointer-events-none absolute inset-x-0 z-10 h-0.5 rounded bg-primary ${drop === 'before' ? 'top-0' : 'bottom-0'}`} />}
          <div className="flex h-9 items-stretch rounded-md hover:bg-accent">
          {!groupWindow && <button {...handle} aria-label={`拖动分组 ${group.name}`} title="拖动分组排序（置顶与未置顶分开）" disabled={sortingDisabled}
            className="flex h-full w-5 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground/60 hover:bg-accent hover:text-foreground active:cursor-grabbing disabled:cursor-default focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onKeyDown={event => {
              const target = event.key === 'ArrowUp' ? previousGroup : event.key === 'ArrowDown' ? nextGroup : null;
              if (!target || sortingDisabled) return;
              event.preventDefault();
              void onMoveGroup(scope, group.id, target.id, event.key === 'ArrowUp' ? 'before' : 'after').catch(() => {});
            }}><GripVertical className="h-3.5 w-3.5" /></button>}
          <button type="button" className="flex h-full min-w-0 flex-1 select-none items-center gap-1.5 rounded px-1 text-left text-xs font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring" aria-expanded={isOpen}
            onPointerDown={event => { if (event.pointerType === 'mouse' && !sortingDisabled) handle.onPointerDown?.(event); }} onDragStart={handle.onDragStart}
            onClick={() => expand(group.id)}>{isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}<span className="min-w-0 flex-1 truncate">{group.name}</span>{group.isPinned && <Pin className="h-3 w-3" />}<span className="text-[10px] text-muted-foreground">{group.members.length}</span></button>
          <ActionMenu label="分组菜单" ariaLabel={`${group.name} 分组菜单`} icon={MoreHorizontal} iconOnly portal variant="ghost" triggerClassName="h-9 w-8 shrink-0 p-0" disabled={saving} items={[{
                  key: 'new',
                  label: '新建对话',
                  icon: Plus,
                  onSelect: () => setModal({
                    kind: 'new',
                    groupId: group.id
                  })
                }, {
                  key: 'pin',
                  label: group.isPinned ? '取消置顶' : '置顶分组',
                  icon: Pin,
                  onSelect: () => {
                    void update(state => {
                      const g = state.groups.find(g => g.id === group.id);
                      if (g) g.isPinned = !group.isPinned;
                      return state;
                    }).catch(() => {});
                  }
                }, {
                  key: 'rename',
                  label: '重命名分组',
                  onSelect: () => setModal({
                    kind: 'group',
                    group
                  })
                }, {
                  key: 'up', label: '上移分组', disabled: sortingDisabled || !previousGroup,
                  onSelect: () => { if (previousGroup) void onMoveGroup(scope, group.id, previousGroup.id, 'before').catch(() => {}); }
                }, {
                  key: 'down', label: '下移分组', disabled: sortingDisabled || !nextGroup,
                  onSelect: () => { if (nextGroup) void onMoveGroup(scope, group.id, nextGroup.id, 'after').catch(() => {}); }
                }, {
                  key: 'window',
                  label: '在新窗口打开整个分组',
                  icon: ExternalLink,
                  onSelect: () => window.open(`/?group=${encodeURIComponent(group.id)}`, '_blank', 'popup,width=1200,height=900,noopener')
                }, {
                  key: 'delete',
                  label: '删除分组',
                  icon: Trash2,
                  isDanger: true,
                  showDividerBefore: true,
                  onSelect: () => setModal({
                    kind: 'remove',
                    group
                  })
                }]} /></div>{isOpen && <div className="pl-2">{group.members.map((member, index) => filtered(resolvedMember(member)) ? renderRow(member, group, index) : null)}{!group.members.length && <p className="p-2 text-xs text-muted-foreground">从会话菜单移入，或在此新建对话。</p>}</div>}</section>;
          })}
        {!groupsToShow.length && <p className="p-4 text-xs leading-relaxed text-muted-foreground">创建一个分组，把不同机器上的对话放在一起。连接机器后会自动导入原有分组。</p>}</>}
        {mode === 'projects' && remotes.map(remote => <section key={remote.id}><div className="flex items-center gap-1.5 px-1 py-2 text-xs font-medium text-muted-foreground"><Server className="h-3.5 w-3.5" />{remote.name}</div>{states[remote.id]?.projects.map(project => {
            const id = `${remote.id}:${project.projectId}`,
              open = expanded.has(id);
            const rows = projectRows[id] ?? (project.sessions ?? []).map(s => normalizeConversation(remote.id, {
              ...s,
              projectId: project.projectId,
              projectPath: project.fullPath
            }));
            return <div key={id}><div className="flex h-9 items-stretch rounded-md hover:bg-accent"><button type="button" aria-expanded={open} className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded px-1 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring" onClick={() => {
                  expand(id);
                  if (!open && !projectRows[id]) void loadProject(remote.id, project.projectId);
                }}>{open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}<Folder className="h-3.5 w-3.5" /><span className="truncate" title={project.fullPath}>{project.displayName}</span></button><button aria-label={`在 ${project.displayName} 新建`} onClick={() => setModal({
                  kind: 'new',
                  remoteId: remote.id,
                  projectId: project.projectId
                })} className="flex h-full w-8 shrink-0 items-center justify-center rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"><Plus className="h-3.5 w-3.5" /></button></div>{open && <div className="pl-2">{rows.filter(filtered).map(m => renderRow(m))}{rows.length < (project.sessionMeta?.total ?? 0) && <button disabled={loadingRows.has(id)} className="p-2 text-xs text-primary" onClick={() => void loadProject(remote.id, project.projectId, true)}>加载更多</button>}</div>}</div>;
          })}</section>)}
        {(mode === 'recent' || mode === 'running') && <>{allConversations.filter(c => mode !== 'running' || states[c.remoteId]?.running.includes(c.sessionId)).filter(filtered).sort((a, b) => Date.parse(b.lastActivity ?? '') - Date.parse(a.lastActivity ?? '')).map(c => renderRow(c))}{mode === 'recent' && remotes.filter(r => (states[r.id]?.total ?? 0) > (states[r.id]?.conversations.length ?? 0)).map(r => <button key={r.id} className="p-2 text-xs text-primary" onClick={() => {
            void hubApi.recent(r.id, states[r.id].conversations.length).then(data => setStates(current => ({
              ...current,
              [r.id]: {
                ...current[r.id],
                conversations: [...current[r.id].conversations, ...data.conversations.map((row: Record<string, unknown>) => normalizeConversation(r.id, row))]
              }
            }))).catch(cause => setError(String(cause)));
          }}>加载更多 · {r.name}</button>)}</>}
      </div>
      <div className="border-t border-border px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">通过本机 SSH 隧道连接 · Claude 在远端运行</div>
      {!sidebar.narrow && <div role="separator" tabIndex={0} aria-label="调整左侧栏宽度" aria-orientation="vertical" aria-valuemin={sidebar.minWidth} aria-valuemax={sidebar.maxWidth} aria-valuenow={Math.round(sidebar.width)} onPointerDown={sidebar.beginResize} onPointerMove={sidebar.moveResize} onPointerUp={sidebar.endResize} onPointerCancel={sidebar.endResize} onLostPointerCapture={sidebar.endResize} onKeyDown={sidebar.keyResize} className="absolute inset-y-0 -right-1 z-50 w-2 cursor-col-resize touch-none hover:bg-primary/40 focus-visible:bg-primary/40 focus-visible:outline-none" />}
    </aside>}
    <main className="relative flex min-w-0 flex-1 flex-col">
      {!sidebarOpen && !selectedPanel?.overlayOpen && !selectedPanel?.settingsOpen && <Button variant="outline" size="icon" aria-label="展开左侧栏" title="展开左侧栏" className="absolute left-2 top-2 z-40 h-9 w-9 bg-background/95 shadow-sm" onClick={() => setSidebarOpen(true)}><PanelLeftOpen className="h-4 w-4" />{notifications.some(n => !n.seen) && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary" />}</Button>}
      {selectedRemote && !selectedPanel?.overlayOpen && !selectedPanel?.settingsOpen && <Button variant="outline" size="icon" aria-label={rightPanelOpen ? '收起右侧工作区' : '打开右侧工作区'} title={`${rightPanelOpen ? '收起' : '打开'}右侧工作区 · ${selectedRemote.name}`} aria-expanded={rightPanelOpen} className="absolute right-2 top-2 z-40 h-9 w-9 bg-background/95 shadow-sm" onClick={toggleRightPanel}>{rightPanelOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}</Button>}
      {selectedRemote && states[selectedRemote.id]?.status === 'offline' && <div role="status" className="bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">{selectedRemote.name} 连接中断，其他机器仍可使用。<button className="ml-2 underline" onClick={() => void refresh(selectedRemote.id)}>重新连接</button></div>}
      {selectedRemote && !selectedPanel && <div className={`flex min-h-[52px] min-w-0 shrink-0 items-center gap-2 border-b border-border bg-background pr-14 ${sidebarOpen ? 'pl-3' : 'pl-14'}`}><div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{selection?.title ?? '工作区'}</div><div className="truncate text-xs text-muted-foreground">{selectedRemote.name}</div></div><Button variant="ghost" size="icon" aria-label={`${selectedRemote.name} 的设置`} title={`${selectedRemote.name} 的设置`} aria-haspopup="dialog" onClick={() => openSettings(selectedRemote.id)} className="h-11 w-11 shrink-0"><Settings className="h-[18px] w-[18px]" /></Button></div>}
      {panes.map(pane => <iframe
        name="cloudcli-remote" key={pane.remoteId}
        ref={frame => registerPane(pane.remoteId, frame)}
        src={`/remote/${encodeURIComponent(pane.remoteId)}/${pane.initialSessionId ? 'session/' + encodeURIComponent(pane.initialSessionId) : ''}?embedded=1`}
        title={`${remotes.find(remote => remote.id === pane.remoteId)?.name ?? pane.remoteId} 对话`}
        hidden={selectedRemote?.id !== pane.remoteId}
        className={selectedRemote?.id === pane.remoteId ? 'min-h-0 w-full flex-1 border-0' : 'hidden'}
        allow="clipboard-read; clipboard-write; fullscreen"
      />)}
      {selectedRemote && fallbackToolsRemote === selectedRemote.id && !selectedPanel && <aside aria-label="右侧工作区" className="absolute bottom-0 right-0 top-[52px] z-30 flex w-[300px] max-w-full flex-col gap-3 border-l border-border bg-background p-4 shadow-lg">
        <div className="flex min-h-10 items-center gap-2"><div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{selection?.title ?? '工作区'}</div><div className="truncate text-xs text-muted-foreground">{selectedRemote.name}</div></div><Button variant="ghost" size="icon" aria-label="关闭工作区工具" onClick={() => setFallbackToolsRemote(null)}><PanelRightClose className="h-4 w-4" /></Button></div>
        <HubWorkspaceToolbar navigation={navigation[selectedRemote.id]} onSelect={tab => selectTab(selectedRemote.id, tab)} />
      </aside>}
      {selectedRemote ? null : <div className="flex flex-1 items-center justify-center p-8 text-center"><div className="max-w-sm"><Server className="mx-auto mb-4 h-8 w-8 text-muted-foreground" /><h1 className="text-lg font-semibold">选择一段对话，继续工作</h1><p className="mt-3 text-sm leading-relaxed text-muted-foreground">先在侧栏连接各台机器。登录使用对应远端的 CloudCLI 账号，项目操作和 Claude 执行都发生在那里。</p><Button className="mt-5" onClick={() => setModal({
            kind: 'new'
          })}>新建对话</Button></div></div>}
    </main>
    {sidebar.resizing && <div className="fixed inset-0 z-40 cursor-col-resize" aria-hidden />}
    {showChatBackups && <LocalChatBackupsDialog remotes={remotes} backupSync={backupSync} onClose={() => setShowChatBackups(false)} onGroupsRestored={next => {
      setGroups(current => next.revision >= current.revision ? next : current);
      groupChannel.current?.postMessage('changed');
    }} onRestored={(remoteId, result) => {
      setShowChatBackups(false);
      openMember({ remoteId, sessionId: result.sessionId, provider: result.provider, title: result.sessionName, projectId: '', projectPath: result.projectPath });
      void refresh(remoteId);
      void loadHubGroups().then(next => setGroups(current => next.revision >= current.revision ? next : current)).catch(cause => setError(cause instanceof Error ? cause.message : '无法读取恢复后的分组'));
    }} />}
    {showNotifications && <div className="absolute right-3 top-14 z-40 w-80 max-w-[95vw] rounded-lg border border-border bg-popover p-3 shadow-xl"><div className="mb-2 flex items-center justify-between text-sm font-medium">通知<button aria-label="关闭通知" onClick={() => setShowNotifications(false)}><X className="h-4 w-4" /></button></div>{notifications.length ? notifications.map(n => <button key={n.id} className="block w-full rounded p-2 text-left text-xs hover:bg-accent" onClick={() => {
        const member = byKey.get(`${n.remoteId}:${n.sessionId}`);
        if (member) openMember(member);
        setShowNotifications(false);
      }}>{remotes.find(r => r.id === n.remoteId)?.name} · {byKey.get(`${n.remoteId}:${n.sessionId}`)?.title ?? '会话'} · {n.label}</button>) : <p className="p-2 text-xs text-muted-foreground">暂无新通知</p>}</div>}
    {conversationAction && <HubConversationDialog key={`${conversationAction.kind}:${memberKey(conversationAction.member)}`} action={conversationAction} machine={remotes.find(remote => remote.id === conversationAction.member.remoteId)?.name ?? conversationAction.member.remoteId} busySession={Boolean(states[conversationAction.member.remoteId]?.running.includes(conversationAction.member.sessionId))} close={() => setConversationAction(null)} onDone={async (action, result) => {
      const key = memberKey(action.member);
      await update(state => {
        for (const group of state.groups) {
          if (action.kind === 'delete') group.members = group.members.filter(member => memberKey(member) !== key);
          else if (action.kind === 'rename' && result) group.members = group.members.map(member => memberKey(member) === key ? result : member);
        }
        if (action.kind === 'fork' && result) {
          const group = state.groups.find(group => group.id === action.groupId) ?? state.groups.find(group => group.members.some(member => memberKey(member) === key));
          if (group && !group.members.some(member => memberKey(member) === memberKey(result))) group.members.push(result);
        }
        return state;
      });
      setProjectRows(current => Object.fromEntries(Object.entries(current).map(([id, rows]) => [id, action.kind === 'delete' ? rows.filter(member => memberKey(member) !== key) : rows.map(member => action.kind === 'rename' && memberKey(member) === key && result ? result : member)])));
      if (action.kind === 'delete') {
        markRead(action.member.remoteId, action.member.sessionId);
        setStates(current => ({ ...current, [action.member.remoteId]: { ...current[action.member.remoteId], conversations: current[action.member.remoteId].conversations.filter(member => memberKey(member) !== key), projects: current[action.member.remoteId].projects.map(project => ({ ...project, sessions: project.sessions?.filter(session => session.id !== action.member.sessionId) })) } }));
        if (selection && memberKey(selection) === key) {
          setSelection(null); setLoginRemote(action.member.remoteId); navigatePane(action.member.remoteId, null);
          const url = new URL(location.href); url.searchParams.delete('session'); history.replaceState(null, '', url);
        }
      } else if (result && (action.kind === 'fork' || selection && memberKey(selection) === key)) openMember(result);
      await refresh(action.member.remoteId);
    }} />}
    {modal && <HubDialog key={`${modal.kind}:${'group' in modal ? modal.group?.id ?? 'new' : ''}`} modal={modal} groups={groups.groups} remotes={remotes} states={states} close={() => setModal(null)} onAssign={assign} onUpdate={update} onCreated={member => {
      openMember(member);
      void refresh(member.remoteId);
      if (modal.kind === 'new' && modal.groupId) setExpanded(current => new Set(current).add(modal.groupId!));
    }} />}
  </div>;
}
/** Local management shell; each conversation pane retains an independent remote App. */
/** Mounted by the app entry when the local hub serves its unified remote sidebar. */
export default function RemoteHubApp() {
  return <ThemeProvider><Hub /></ThemeProvider>;
}
