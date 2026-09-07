import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { changeHubGroups, loadHubGroups, hubApi } from '@/shared/api';
import type { HubRemote, HubRemoteState, HubConversation, HubGroup, HubGroupState } from '@/shared/types';
import { Bell, ChevronDown, ChevronRight, ExternalLink, Folder, Layers, MoreHorizontal, Pin, Plus, RefreshCw, Server, Settings, Trash2, X } from 'lucide-react';

import { ThemeProvider } from '@/shared/context/ThemeContext';
import { ActionMenu, Button, Dialog, DialogContent, DialogTitle, Input } from '@/shared/ui';
import { useConversationGroupDrag } from '@/modules/sidebar';
import { memberKey, moveHubMember, normalizeConversation } from '@/modules/remote-hub/utils/hubClient';
import { useHubConnections } from '@/modules/remote-hub/hooks/useHubConnections';
const emptyGroups: HubGroupState = {
  revision: 0,
  groups: [],
  imported: []
};
type Modal = {
  kind: 'group';
  group?: HubGroup;
} | {
  kind: 'remove';
  group: HubGroup;
} | {
  kind: 'assign';
  member: HubConversation;
} | {
  kind: 'new';
  groupId?: string;
  remoteId?: string;
  projectId?: string;
};
const selectClass = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm';
function Hub() {
  // Registered SSH tunnel destinations populate the machine picker.
  const [remotes, setRemotes] = useState<HubRemote[]>([]);
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
  // Separates embedded navigation from title-only selection updates.
  const [paneLocation, setPaneLocation] = useState<{remoteId:string;sessionId:string|null;version:number}|null>(null);
  // Retains the current group or conversation dialog operation.
  const [modal, setModal] = useState<Modal | null>(null);
  // Allows the sidebar to be collapsed on a narrow workspace.
  const [sidebarOpen, setSidebarOpen] = useState(true);
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
  const frames = useRef<HTMLIFrameElement | null>(null);
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
    setStates
  } = useHubConnections(remotes, onNotification);
  // Retains loaded project pages across sidebar view changes.
  const [projectRows, setProjectRows] = useState<Record<string, HubConversation[]>>({});
  // Displays pending page loads independently for each remote project.
  const [loadingRows, setLoadingRows] = useState<Set<string>>(new Set());
  const projectLoads = useRef(new Set<string>());
  const allConversations = useMemo(() => Object.values(states).flatMap(s => s.conversations), [states]);
  const byKey = useMemo(() => new Map(allConversations.map(c => [memberKey(c), c])), [allConversations]);
  const resolvedMember = (member: HubConversation) => byKey.get(memberKey(member)) ?? member;
  const filtered = (member: HubConversation) => `${member.title} ${member.projectPath} ${remotes.find(r => r.id === member.remoteId)?.name}`.toLowerCase().includes(query.toLowerCase());
  const selectedRemote = remotes.find(r => r.id === (selection?.remoteId ?? loginRemote));
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
  const expand = (id: string) => setExpanded(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);else next.add(id);
    return next;
  });
  const openMember = (member: HubConversation) => {
    setSelection(resolvedMember(member));
    setLoginRemote(null);
    setPaneLocation(current=>({remoteId:member.remoteId,sessionId:member.sessionId,version:(current?.version??0)+1}));
    if (window.innerWidth < 760) setSidebarOpen(false);
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
    if (fromLink || fromGroup) { const member=fromLink??fromGroup!; setSelection(member); setPaneLocation(current=>({remoteId:member.remoteId,sessionId:member.sessionId,version:(current?.version??0)+1})); }
  }, [allConversations, groups, groupWindow, selection, loginRemote]);
  useEffect(() => {
    const message = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== frames.current?.contentWindow || event.data?.kind !== 'cloudcli:selection') return;
      const remoteId = paneLocation?.remoteId;
      if (!remoteId || typeof event.data.sessionId !== 'string') return;
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
  }, [paneLocation?.remoteId]);
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
    const running = states[member.remoteId]?.running.includes(member.sessionId);
    const before = group?.members[index - 1],
      after = group?.members[index + 1];
    const target = drag.dropTarget?.sessionId === key ? drag.dropTarget.position : null;
    return <div key={key} data-testid="hub-conversation-row" data-group-id={group?.id} data-session-id={key} {...group ? drag.rowProps(group.id, key) : {}} className={`relative flex h-8 min-w-0 items-center gap-1 rounded-md px-1 hover:bg-accent ${selection && memberKey(selection) === key ? 'bg-primary/10' : ''} ${drag.dragState?.sessionId === key ? 'opacity-50' : ''}`}>
      {target && <span className={`pointer-events-none absolute inset-x-0 h-0.5 bg-primary ${target === 'before' ? 'top-0' : 'bottom-0'}`} />}
      {group ? <button {...drag.dragHandleProps(group.id, key)} disabled={saving} aria-label={`拖动 ${member.title}`} className="h-7 w-5 shrink-0 cursor-grab text-muted-foreground">⋮</button> : <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${running ? 'animate-pulse bg-emerald-500' : 'bg-muted-foreground/40'}`} />}
      <a href={`/?remote=${member.remoteId}&session=${member.sessionId}`} className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px]" title={`${member.title}\n${remotes.find(r => r.id === member.remoteId)?.name}\n${member.projectPath}`} onClick={e => {
        if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.defaultPrevented) return;
        e.preventDefault();
        openMember(member);
      }}>
        <span className="min-w-0 flex-1 truncate">{member.title}</span><span className={`max-w-16 truncate text-[10px] ${status === 'online' ? 'text-muted-foreground' : 'text-amber-600'}`}>{running ? '● ' : ''}{remotes.find(r => r.id === member.remoteId)?.name}</span>
      </a>
      <ActionMenu label="会话菜单" ariaLabel={`${member.title} 的菜单`} icon={MoreHorizontal} iconOnly portal variant="ghost" triggerClassName="h-7 w-7 p-0" disabled={saving} items={[{
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
      }]} />
    </div>;
  };
  const groupsToShow = [...groups.groups].sort((a, b) => Number(b.isPinned) - Number(a.isPinned)).filter(g => !groupWindow || g.id === groupWindow);
  const openFrame = paneLocation ? `/remote/${paneLocation.remoteId}/${paneLocation.sessionId ? 'session/'+encodeURIComponent(paneLocation.sessionId) : ''}?embedded=1` : null;
  return <div className="fixed inset-0 flex bg-background text-foreground">
    {sidebarOpen && <aside className="absolute inset-y-0 left-0 z-30 flex w-[320px] max-w-[88vw] flex-col border-r border-border bg-card md:relative md:max-w-none" data-testid="hub-sidebar">
      <div className="flex h-14 items-center gap-2 px-4"><Layers className="h-5 w-5 text-primary" /><strong className="flex-1">CloudCLI</strong><Button variant="ghost" size="icon" aria-label="通知" onClick={() => {
          setShowNotifications(!showNotifications);
          setNotifications(items => items.map(n => ({
            ...n,
            seen: true
          })));
        }}><Bell className="h-4 w-4" />{notifications.some(n => !n.seen) && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}</Button><Button variant="ghost" size="icon" aria-label="关闭侧栏" className="md:hidden" onClick={() => setSidebarOpen(false)}><X /></Button></div>
      <div className="space-y-1 px-3 pb-3">{remotes.map(remote => <div key={remote.id} className="flex items-center gap-2 text-xs"><span className={`h-1.5 w-1.5 rounded-full ${states[remote.id]?.status === 'online' ? 'bg-emerald-500' : states[remote.id]?.status === 'loading' ? 'bg-muted-foreground' : 'bg-amber-500'}`} /><span className="min-w-0 flex-1 truncate" title={remote.name}>{remote.name}</span><button className="rounded px-1.5 py-1 text-muted-foreground hover:bg-accent" onClick={() => {
            setLoginRemote(remote.id);
            setSelection(null);
            setPaneLocation(current=>({remoteId:remote.id,sessionId:null,version:(current?.version??0)+1}));
          }}>{states[remote.id]?.status === 'login' ? '登录' : states[remote.id]?.status === 'offline' ? '离线' : states[remote.id]?.status === 'online' ? '已连接' : '连接中'}</button><button aria-label={`刷新 ${remote.name}`} onClick={() => void refresh(remote.id)} className="p-1"><RefreshCw className="h-3 w-3" /></button></div>)}</div>
      <div className="mx-3 flex gap-1 rounded-lg bg-muted p-1">{([['groups', '分组'], ['projects', '项目'], ['recent', '最近'], ['running', '运行中']] as const).map(([id, label]) => <button key={id} onClick={() => setMode(id)} className={`flex-1 rounded-md py-1.5 text-xs ${mode === id ? 'bg-background shadow-sm' : ''}`}>{label}</button>)}</div>
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
            return <section key={group.id} data-testid="hub-group" data-group-id={group.id}>
          <div className="flex h-9 items-center gap-1 rounded-md pr-1 hover:bg-accent"><button className="flex min-w-0 flex-1 items-center gap-1.5 px-1 text-left text-xs font-medium" aria-expanded={isOpen} onClick={() => expand(group.id)}>{isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}<span className="min-w-0 flex-1 truncate">{group.name}</span>{group.isPinned && <Pin className="h-3 w-3" />}<span className="text-[10px] text-muted-foreground">{group.members.length}</span></button>
          <ActionMenu label="分组菜单" ariaLabel={`${group.name} 分组菜单`} icon={MoreHorizontal} iconOnly portal variant="ghost" triggerClassName="h-7 w-7 p-0" disabled={saving} items={[{
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
            return <div key={id}><div className="flex items-center"><button className="flex h-9 min-w-0 flex-1 items-center gap-1.5 px-1 text-xs" onClick={() => {
                  expand(id);
                  if (!open && !projectRows[id]) void loadProject(remote.id, project.projectId);
                }}>{open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}<Folder className="h-3.5 w-3.5" /><span className="truncate" title={project.fullPath}>{project.displayName}</span></button><button aria-label={`在 ${project.displayName} 新建`} onClick={() => setModal({
                  kind: 'new',
                  remoteId: remote.id,
                  projectId: project.projectId
                })} className="p-2"><Plus className="h-3.5 w-3.5" /></button></div>{open && <div className="pl-2">{rows.filter(filtered).map(m => renderRow(m))}{rows.length < (project.sessionMeta?.total ?? 0) && <button disabled={loadingRows.has(id)} className="p-2 text-xs text-primary" onClick={() => void loadProject(remote.id, project.projectId, true)}>加载更多</button>}</div>}</div>;
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
    </aside>}
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="flex min-h-12 items-center gap-2 border-b border-border px-3"><Button variant="ghost" size="icon" aria-label="展开侧栏" onClick={() => setSidebarOpen(!sidebarOpen)}><Layers className="h-4 w-4" /></Button><div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{selection?.title ?? (loginRemote ? '连接远端' : '所有远端，一个窗口')}</div>{selectedRemote && <div className="flex items-center gap-1 text-xs text-muted-foreground"><Server className="h-3 w-3" /><span>{selectedRemote.name}</span>{selection?.projectPath && <span className="truncate"> · {selection.projectPath}</span>}</div>}</div>{selectedRemote && <Button variant="ghost" size="sm" onClick={() => frames.current?.contentWindow?.postMessage({
          kind: 'cloudcli:settings'
        }, location.origin)}><Settings className="h-3.5 w-3.5" />机器设置</Button>}</header>
      {selectedRemote && states[selectedRemote.id]?.status === 'offline' && <div role="status" className="bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">{selectedRemote.name} 连接中断，其他机器仍可使用。<button className="ml-2 underline" onClick={() => void refresh(selectedRemote.id)}>重新连接</button></div>}
      {openFrame ? <iframe name="cloudcli-remote" key={paneLocation?.version} ref={frames} src={openFrame} title={`${selectedRemote?.name} 对话`} className="min-h-0 w-full flex-1 border-0" allow="clipboard-read; clipboard-write; fullscreen" /> : <div className="flex flex-1 items-center justify-center p-8 text-center"><div className="max-w-sm"><Server className="mx-auto mb-4 h-8 w-8 text-muted-foreground" /><h1 className="text-lg font-semibold">选择一段对话，继续工作</h1><p className="mt-3 text-sm leading-relaxed text-muted-foreground">先在侧栏连接各台机器。登录使用对应远端的 CloudCLI 账号，项目操作和 Claude 执行都发生在那里。</p><Button className="mt-5" onClick={() => setModal({
            kind: 'new'
          })}>新建对话</Button></div></div>}
    </main>
    {showNotifications && <div className="absolute right-3 top-14 z-40 w-80 max-w-[95vw] rounded-lg border border-border bg-popover p-3 shadow-xl"><div className="mb-2 flex items-center justify-between text-sm font-medium">通知<button aria-label="关闭通知" onClick={() => setShowNotifications(false)}><X className="h-4 w-4" /></button></div>{notifications.length ? notifications.map(n => <button key={n.id} className="block w-full rounded p-2 text-left text-xs hover:bg-accent" onClick={() => {
        const member = byKey.get(`${n.remoteId}:${n.sessionId}`);
        if (member) openMember(member);
        setShowNotifications(false);
      }}>{remotes.find(r => r.id === n.remoteId)?.name} · {byKey.get(`${n.remoteId}:${n.sessionId}`)?.title ?? '会话'} · {n.label}</button>) : <p className="p-2 text-xs text-muted-foreground">暂无新通知</p>}</div>}
    {modal && <HubDialog key={`${modal.kind}:${'group' in modal ? modal.group?.id ?? 'new' : ''}`} modal={modal} groups={groups.groups} remotes={remotes} states={states} close={() => setModal(null)} onAssign={assign} onUpdate={update} onCreated={member => {
      openMember(member);
      void refresh(member.remoteId);
      if (modal.kind === 'new' && modal.groupId) setExpanded(current => new Set(current).add(modal.groupId!));
    }} />}
  </div>;
}
function HubDialog({
  modal,
  groups,
  remotes,
  states,
  close,
  onAssign,
  onUpdate,
  onCreated
}: {
  modal: Modal;
  groups: HubGroup[];
  remotes: HubRemote[];
  states: Record<string, HubRemoteState>;
  close: () => void;
  onAssign: (member: HubConversation, groupId: string | null) => Promise<void>;
  onUpdate: (change: (state: HubGroupState) => HubGroupState) => Promise<void>;
  onCreated: (member: HubConversation) => void;
}) {
  const remembered = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem('cloudcli-hub-last-folder') ?? '{}');
    } catch {
      return {};
    }
  }, []);
  // Holds the unsaved group name while its dialog is open.
  const [name, setName] = useState(modal.kind === 'group' ? modal.group?.name ?? '' : '');
  // Holds the target membership chosen for a new or existing conversation.
  const [groupId, setGroupId] = useState(modal.kind === 'assign' ? groups.find(g => g.members.some(m => memberKey(m) === memberKey(modal.member)))?.id ?? '' : modal.kind === 'new' ? modal.groupId ?? '' : '');
  // Tracks the machine chosen before selecting its project folder.
  const [remoteId, setRemoteId] = useState(modal.kind === 'new' ? modal.remoteId ?? remembered.remoteId ?? remotes.find(r => states[r.id]?.status === 'online')?.id ?? remotes[0]?.id ?? '' : '');
  const projects = states[remoteId]?.projects ?? [];
  // Tracks the folder selected on the chosen remote.
  const [projectId, setProjectId] = useState(modal.kind === 'new' ? modal.projectId ?? remembered.projectId ?? '' : '');
  // Selects the remote coding provider for the conversation draft.
  const [provider, setProvider] = useState('claude');
  // Prevents duplicate session or group creation while a request is in flight.
  const [busy, setBusy] = useState(false);
  // A visible failure is retained until the user retries or dismisses it.
  const [error, setError] = useState('');
  // Retains a successfully created draft so retrying group assignment cannot duplicate it.
  const [created, setCreated] = useState<HubConversation | null>(null);
  const project = projects.find(p => p.projectId === projectId);
  const title = modal.kind === 'group' ? modal.group ? '重命名分组' : '新建分组' : modal.kind === 'remove' ? '删除分组' : modal.kind === 'assign' ? '移到分组' : '新建对话';
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (modal.kind === 'group') {
        const id = modal.group?.id ?? crypto.randomUUID();
        await onUpdate(state => {
          const existing = state.groups.find(g => g.id === id);
          if (existing) existing.name = name.trim();else state.groups.push({
            id,
            name: name.trim(),
            isPinned: false,
            members: []
          });
          return state;
        });
      } else if (modal.kind === 'remove') await onUpdate(state => ({
        ...state,
        groups: state.groups.filter(g => g.id !== modal.group.id)
      }));else if (modal.kind === 'assign') await onAssign(modal.member, groupId || null);else {
        if (!project || states[remoteId]?.status !== 'online') throw new Error('请选择一台在线机器和已有项目文件夹');
        let member = created;
        if (!member) {
          const result = await hubApi.createSession(remoteId, { provider, projectPath: project.fullPath });
          member = {
            remoteId,
            sessionId: result.sessionId,
            title: result.sessionName ?? '新对话',
            projectId: project.projectId,
            projectPath: project.fullPath,
            provider
          };
          setCreated(member);
        }
        // If group persistence fails, retry assigns the already-created draft;
        // it must not allocate a second remote conversation.
        if (groupId) await onAssign(member, groupId);
        localStorage.setItem('cloudcli-hub-last-folder', JSON.stringify({
          remoteId,
          projectId
        }));
        onCreated(member);
      }
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };
  return <Dialog open onOpenChange={open => {
    if (!open && !busy) close();
  }}><DialogContent className="max-h-[90dvh] max-w-md overflow-y-auto p-5" aria-describedby="hub-dialog-description"><form onSubmit={event => {
        event.preventDefault();
        void submit();
      }} className="space-y-4"><DialogTitle className="not-sr-only text-lg font-semibold">{title}</DialogTitle><p id="hub-dialog-description" className="text-sm text-muted-foreground">{modal.kind === 'remove' ? `删除“${modal.group.name}”只移除分组，不会删除任何机器上的会话。` : modal.kind === 'new' ? '选择机器，再选择工作文件夹。Claude 将在该远端执行。' : '分组保存在本机，可以包含多台机器上的会话。'}</p>
    {modal.kind === 'group' && <label className="block text-sm">分组名称<Input aria-label="分组名称" value={name} onChange={e => setName(e.target.value)} required maxLength={80} autoFocus className="mt-1" disabled={busy} /></label>}
    {modal.kind === 'new' && <><label className="block text-sm">机器<select aria-label="机器" className={`${selectClass} mt-1`} value={remoteId} disabled={busy || Boolean(created)} onChange={e => {
              setRemoteId(e.target.value);
              setProjectId('');
            }} required><option value="" disabled>选择机器</option>{remotes.map(r => <option key={r.id} value={r.id} disabled={states[r.id]?.status !== 'online'}>{r.name}{states[r.id]?.status !== 'online' ? ' · 未连接' : ''}</option>)}</select></label><label className="block text-sm">项目文件夹<select aria-label="项目文件夹" className={`${selectClass} mt-1`} value={projectId} disabled={busy || Boolean(created)} onChange={e => setProjectId(e.target.value)} required><option value="" disabled>选择工作文件夹</option>{projects.map(p => <option key={p.projectId} value={p.projectId}>{p.displayName} — {p.fullPath}</option>)}</select></label><label className="block text-sm">执行工具<select aria-label="执行工具" className={`${selectClass} mt-1`} value={provider} disabled={busy || Boolean(created)} onChange={e => setProvider(e.target.value)}><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="cursor">Cursor</option><option value="opencode">OpenCode</option></select></label></>}
    {(modal.kind === 'new' || modal.kind === 'assign') && <label className="block text-sm">分组<select aria-label="分组" className={`${selectClass} mt-1`} value={groupId} onChange={e => setGroupId(e.target.value)} disabled={busy}><option value="">不分组</option>{groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label>}
    {error && <p role="alert" className="text-sm text-destructive">{error}{created && ' 会话已经创建，重试只会保存分组归属。'}</p>}
    <div className="flex justify-end gap-2"><Button type="button" variant="ghost" disabled={busy} onClick={close}>取消</Button><Button type="submit" variant={modal.kind === 'remove' ? 'destructive' : 'default'} disabled={busy || modal.kind === 'group' && !name.trim() || modal.kind === 'new' && !project}>{busy ? '保存中…' : modal.kind === 'remove' ? '删除分组' : modal.kind === 'new' ? '创建对话' : '保存'}</Button></div>
  </form></DialogContent></Dialog>;
}

/** Local management shell; each conversation pane retains an independent remote App. */
/** Mounted by the app entry when the local hub serves its unified remote sidebar. */
export default function RemoteHubApp() {
  return <ThemeProvider><Hub /></ThemeProvider>;
}
