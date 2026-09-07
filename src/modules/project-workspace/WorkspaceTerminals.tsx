import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Terminal, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { StandaloneShell } from '@/modules/standalone-shell';
import { Button } from '@/shared/ui';
import type { Project, ProjectSession } from '@/shared/types';
import { getSessionTitle } from '@/shared/utils';

type TerminalEntry = { id: string; project: Project; session: ProjectSession | null; plain: boolean; label: string };

/** Used by WorkspaceMain to keep each remote terminal bound to its original project and session. */
export default function WorkspaceTerminals({ project, session, visible }: { project: Project | null; session: ProjectSession | null; visible: boolean }) {
  const { t } = useTranslation('common');
  // Retain terminal instances across tab switches and chat navigation; only an explicit close removes one.
  const [terminals, setTerminals] = useState<TerminalEntry[]>([]);
  // Select a retained instance without changing its original launch props.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const initiallyOpened = useRef(false);
  const terminationActions = useRef(new Map<string, () => Promise<boolean>>());
  // Keep a disconnected terminal visible until its PTY can be explicitly stopped.
  const [closeError, setCloseError] = useState<string | null>(null);
  // Wait for the remote PTY acknowledgment before removing its UI and connection.
  const [closingIds, setClosingIds] = useState<ReadonlySet<string>>(new Set());
  const closingRef = useRef(new Set<string>());
  const closeTerminal = async (id: string) => {
    if (closingRef.current.has(id)) return;
    closingRef.current.add(id); setClosingIds(new Set(closingRef.current)); setCloseError(null);
    try {
      const terminated = await terminationActions.current.get(id)?.();
      if (!terminated) {
        setCloseError(t('workspacePanel.reconnectBeforeClose', { defaultValue: 'Reconnect this terminal before closing it so its remote process can be stopped.' }));
        return;
      }
      setTerminals(current => current.filter(item => item.id !== id));
      setSelectedId(current => current === id ? null : current);
    } catch {
      setCloseError(t('workspacePanel.reconnectBeforeClose', { defaultValue: 'Reconnect this terminal before closing it so its remote process can be stopped.' }));
    } finally {
      closingRef.current.delete(id); setClosingIds(new Set(closingRef.current));
    }
  };
  const openTerminal = useCallback((plain: boolean) => {
    if (!project || (!plain && !session)) return;
    setCloseError(null);
    const existing = !plain && terminals.find(item => !item.plain && item.session?.id === session?.id);
    if (existing) { setSelectedId(existing.id); return; }
    const boundSession = plain ? null : session;
    const machine = window.__REMOTE_NAME__ || window.__REMOTE_ID__ || t('workspacePanel.currentRemote', { defaultValue: 'Current remote' });
    const label = `${machine} · ${project.displayName} · ${boundSession ? getSessionTitle(boundSession) : t('workspacePanel.terminal', { defaultValue: 'Terminal' })}`;
    const id = crypto.randomUUID();
    setTerminals(current => [...current, { id, project, session: boundSession, plain, label }]);
    setSelectedId(id);
  }, [project, session, t, terminals]);
  useEffect(() => {
    if (visible && project && !initiallyOpened.current) {
      initiallyOpened.current = true;
      openTerminal(true);
    }
  }, [visible, project, terminals.length, openTerminal]);
  const active = terminals.find(item => item.id === selectedId) ?? terminals[0];
  const canOpenClaude = Boolean(session && (!session.__provider || session.__provider === 'claude'));

  return <div className="flex h-full min-h-0 flex-col" data-testid="workspace-terminals">
    <div className="shrink-0 space-y-1 border-b border-border px-2 py-2">
      <div className="flex flex-wrap items-center gap-1">
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-[11px]" disabled={!project} onClick={() => openTerminal(true)}><Plus className="h-3 w-3" />{t('workspacePanel.newTerminal', { defaultValue: 'New terminal' })}</Button>
        <Button variant="outline" size="sm" className="h-7 max-w-full gap-1 px-2 text-[11px]" disabled={!canOpenClaude} onClick={() => openTerminal(false)}><Terminal className="h-3 w-3 shrink-0" /><span className="truncate">{t('workspacePanel.openClaudeTerminal', { defaultValue: 'Open this Claude session in terminal' })}</span></Button>
      </div>
      {terminals.length > 0 && <div className="flex items-center gap-1">
        <select value={active?.id ?? ''} aria-label={t('workspacePanel.chooseTerminal', { defaultValue: 'Choose retained terminal' })} onChange={event => setSelectedId(event.target.value)} className="h-8 min-w-0 flex-1 rounded border border-input bg-background px-2 text-[11px]">
          {terminals.map((entry, index) => <option key={entry.id} value={entry.id}>{index + 1}. {entry.label}</option>)}
        </select>
        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t('workspacePanel.closeTerminal', { defaultValue: 'Close this terminal and stop its process' })} disabled={Boolean(active && closingIds.has(active.id))} onClick={() => { if (active) void closeTerminal(active.id); }}><X className="h-3.5 w-3.5" /></Button>
      </div>}
      <p className="text-[10px] leading-relaxed text-muted-foreground">{t('workspacePanel.terminalBinding', { defaultValue: 'Each terminal stays on the machine, folder and session shown above when you switch conversations.' })}</p>
    </div>
    {closeError && <p role="alert" className="shrink-0 px-3 py-2 text-xs text-red-600">{closeError}</p>}
    {!project && terminals.length === 0 && <p className="p-4 text-sm text-muted-foreground">{t('workspacePanel.chooseProject', { defaultValue: 'Choose a project to open its remote terminal.' })}</p>}
    {terminals.map(entry => <div key={entry.id} className={`min-h-0 flex-1 ${entry.id === active?.id ? 'block' : 'hidden'}`} data-terminal-binding={entry.id}>
      <StandaloneShell project={entry.project} session={entry.session} isPlainShell={entry.plain} showHeader={false} isActive={visible && entry.id === active?.id} bindingLabel={entry.label} terminalInstanceId={entry.id} onTerminateReady={terminate => { if (terminate) terminationActions.current.set(entry.id, terminate); else terminationActions.current.delete(entry.id); }} />
    </div>)}
  </div>;
}
