import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/shared/ui';
import { useWorkspacePanelActions, useWorkspacePanels } from '@/modules/workspace-panels/context/WorkspacePanelsContext';

type Branch = { sessionId: string; parentSessionId: string; sessionName?: string };
function readBranch(value: unknown): Branch | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<Branch>;
  if (typeof item.sessionId !== 'string' || typeof item.parentSessionId !== 'string' || !/^[\w-]+$/.test(item.sessionId) || !/^[\w-]+$/.test(item.parentSessionId)) return null;
  return { sessionId: item.sessionId, parentSessionId: item.parentSessionId, ...(typeof item.sessionName === 'string' ? { sessionName: item.sessionName } : {}) };
}

/** Used by project-workspace inside the common panel frame; every opened branch keeps its app mounted. */
export function SideChatPanel({ onNavigateToSession }: { onNavigateToSession?: (sessionId: string) => void }) {
  const { t } = useTranslation('common');
  const panel = useWorkspacePanels();
  const actions = useWorkspacePanelActions();
  // Preserve each branch iframe and its draft/stream when a sibling view is selected.
  const [branches, setBranches] = useState<Branch[]>([]);
  // Keep parent navigation separate from retained iframe lifetime.
  const [navigation, setNavigation] = useState<string[]>([]);
  const frames = useRef(new Map<string, HTMLIFrameElement>());
  const currentId = navigation.at(-1);
  const branch = branches.find(item => item.sessionId === currentId);
  const openBranch = useCallback((next: Branch, nested: boolean) => {
    setBranches(current => current.some(item => item.sessionId === next.sessionId) ? current : [...current, next]);
    setNavigation(current => nested ? [...current, next.sessionId] : [next.sessionId]);
    actions?.openPanel('sideChat');
  }, [actions]);

  useEffect(() => {
    const open = (event: Event) => {
      const detail = readBranch((event as CustomEvent<unknown>).detail);
      if (!detail) return;
      if (window.__CLOUDCLI_SIDE_CHAT__ && window.parent !== window) {
        window.parent.postMessage({ kind: 'cloudcli:side-chat-open', detail }, location.origin);
      } else openBranch(detail, false);
    };
    const forwarded = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.data?.kind !== 'cloudcli:side-chat-open') return;
      const source = [...frames.current.entries()].find(([, frame]) => frame.contentWindow === event.source);
      const detail = readBranch(event.data.detail);
      if (source && detail?.parentSessionId === source[0]) openBranch(detail, true);
    };
    window.addEventListener('cloudcli:side-chat-open', open);
    window.addEventListener('message', forwarded);
    return () => { window.removeEventListener('cloudcli:side-chat-open', open); window.removeEventListener('message', forwarded); };
  }, [openBranch]);
  useEffect(() => actions?.setSideChatCount(branches.length), [actions, branches.length]);
  const base = window.__REMOTE_BASE__ ?? '';
  const visible = panel?.open && panel.tab === 'sideChat';

  return <div className={`h-full min-h-0 flex-col ${visible ? 'flex' : 'hidden'}`} data-testid="workspace-side-chat">
    {branch ? <>
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-2">
        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t(navigation.length > 1 ? 'workspacePanel.previousBranch' : 'workspacePanel.returnMain', { defaultValue: navigation.length > 1 ? 'Return to previous side chat' : 'Return to main conversation' })} onClick={() => { if (navigation.length > 1) setNavigation(current => current.slice(0, -1)); else { onNavigateToSession?.(branch.parentSessionId); actions?.collapsePanel(); } }}><ArrowLeft className="h-3.5 w-3.5" /></Button>
        <div className="min-w-0 flex-1">
          <select aria-label={t('workspacePanel.chooseBranch', { defaultValue: 'Choose side chat' })} value={currentId} onChange={event => setNavigation([event.target.value])} className="w-full min-w-0 truncate rounded border-0 bg-background py-1 text-xs font-medium">
            {branches.map(item => <option key={item.sessionId} value={item.sessionId}>{item.sessionName || t('workspacePanel.sideChat', { defaultValue: 'Side chat' })}</option>)}
          </select>
          <p className="truncate text-[10px] text-muted-foreground">{window.__REMOTE_NAME__ || window.__REMOTE_ID__ || t('workspacePanel.currentRemote', { defaultValue: 'Current remote' })} · {t('workspacePanel.sharedFiles', { defaultValue: 'Independent context · shared project files' })}</p>
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t('workspacePanel.openWindow', { defaultValue: 'Open side chat in a new window' })} onClick={() => window.open(`${base}/session/${encodeURIComponent(branch.sessionId)}`, '_blank', 'noopener')}><ExternalLink className="h-3.5 w-3.5" /></Button>
      </div>
    </> : <p className="p-5 text-sm text-muted-foreground">{t('workspacePanel.noSideChat', { defaultValue: 'Open a saved message’s menu to start a side chat.' })}</p>}
    {branches.map(item => <iframe
      key={item.sessionId}
      ref={frame => { if (frame) frames.current.set(item.sessionId, frame); else frames.current.delete(item.sessionId); }}
      name="cloudcli-side-chat"
      src={`${base}/session/${encodeURIComponent(item.sessionId)}?embedded=1&sideChat=1`}
      title={item.sessionName || t('workspacePanel.sideChat', { defaultValue: 'Side chat' })}
      className={`min-h-0 w-full flex-1 border-0 ${item.sessionId === currentId ? 'block' : 'hidden'}`}
      allow="clipboard-read; clipboard-write; fullscreen"
    />)}
  </div>;
}
