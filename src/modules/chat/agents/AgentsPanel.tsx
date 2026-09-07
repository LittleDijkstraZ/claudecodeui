import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Bot, Clock3 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { getSubagentStatus } from '@/shared/utils';
import type { MessageRevealTarget } from '@/shared/types';
import { Button } from '@/shared/ui';
import { useWorkspacePanelActions, useWorkspacePanels } from '@/modules/workspace-panels';
import { getIntrinsicMessageKey } from '@/modules/chat/utils/messageKeys';
import { createCachedDiffCalculator } from '@/modules/chat/utils/messageTransforms';
import { revealConversationChange } from '@/modules/chat/utils/revealConversationChange';
import { SubagentPanel } from '@/modules/chat/tools/SubagentPanel';

/** Used by project-workspace to inspect the current conversation's agents without expanding its transcript. */
export function AgentsPanel() {
  const { t } = useTranslation('common');
  const panel = useWorkspacePanels();
  const actions = useWorkspacePanelActions();
  const snapshot = panel?.agents;
  const messages = snapshot?.messages ?? [];
  const selection = messages.find(message => getIntrinsicMessageKey(message) === panel?.agentReveal?.messageKey)
    ?? messages.find(message => getSubagentStatus(message) === 'running') ?? messages.at(-1);
  const selectedKey = selection ? getIntrinsicMessageKey(selection) : null;
  const status = selection ? getSubagentStatus(selection) : null;
  const visible = Boolean(panel?.open && panel.tab === 'agents');
  const detailRef = useRef<HTMLDivElement>(null);
  const createDiff = useMemo(() => createCachedDiffCalculator(), []);
  // Tick only a visible running agent; recorded completion timestamps remain fixed.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!visible || status !== 'running') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [visible, status, selectedKey]);
  const requestedReveal = panel?.agentReveal;
  const reveal: MessageRevealTarget | undefined = requestedReveal && requestedReveal.messageKey === selectedKey ? requestedReveal : undefined;
  useEffect(() => {
    if (!visible || !reveal || !detailRef.current) return;
    return revealConversationChange(detailRef.current, reveal, () => {});
  }, [visible, reveal]);
  const startedAt = selection ? new Date(selection.timestamp).getTime() : NaN;
  const endedAt = selection?.toolResult?.timestamp ? new Date(selection.toolResult.timestamp).getTime() : NaN;
  const elapsed = Number.isFinite(startedAt) && (status === 'running' || Number.isFinite(endedAt))
    ? Math.max(0, Math.floor(((status === 'running' ? now : endedAt) - startedAt) / 1000)) : null;
  const duration = elapsed === null ? t('workspacePanel.durationUnknown', { defaultValue: 'Duration not recorded' })
    : `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
  const title = selection?.subagent?.name || selection?.subagent?.type || t('workspacePanel.agent', { defaultValue: 'Agent' });

  return <div className="flex h-full min-h-0 flex-col" data-testid="workspace-agents">
    <div className="shrink-0 border-b border-border px-3 py-2">
      <p className="truncate text-[10px] text-muted-foreground">{window.__REMOTE_NAME__ || window.__REMOTE_ID__ || t('workspacePanel.currentRemote', { defaultValue: 'Current remote' })} · {snapshot?.project?.displayName || ''}</p>
      {messages.length > 0 && <select className="mt-1 h-8 w-full min-w-0 rounded border border-input bg-background px-2 text-xs" aria-label={t('workspacePanel.chooseAgent', { defaultValue: 'Choose agent' })} value={selectedKey ?? ''} onChange={event => actions?.openAgent(event.target.value)}>
        {messages.map((message, index) => { const key = getIntrinsicMessageKey(message); return key ? <option key={key} value={key}>{index + 1}. {message.subagent?.name || message.subagent?.type || t('workspacePanel.agent', { defaultValue: 'Agent' })} · {t(`workspacePanel.${getSubagentStatus(message)}`, { defaultValue: getSubagentStatus(message) })}{message.subagent?.description ? ` — ${message.subagent.description}` : ''}</option> : null; })}
      </select>}
      {snapshot?.hasEarlierMessages && <Button variant="ghost" size="sm" className="mt-1 h-6 px-0 text-[10px]" disabled={snapshot.isLoadingEarlierMessages} onClick={snapshot.loadEarlierMessages}>{t('workspacePanel.loadEarlierAgents', { defaultValue: 'Load earlier conversation activity' })}</Button>}
    </div>
    {snapshot?.historyError && <p role="alert" className="shrink-0 px-3 py-2 text-xs text-red-600">{snapshot.historyError}</p>}
    <div ref={detailRef} className="min-h-0 flex-1 overflow-y-auto p-3">
      {selection && selectedKey ? <div data-message-key={selectedKey} tabIndex={-1}>
        <div className="mb-3 flex min-w-0 items-start gap-2">
          <Bot className="mt-0.5 h-4 w-4 shrink-0 text-violet-500" />
          <div className="min-w-0 flex-1"><h3 className="break-words text-sm font-medium">{title}</h3><p className="mt-1 break-words text-xs text-muted-foreground">{selection.subagent?.description}</p></div>
          <span className={`shrink-0 text-[10px] ${status === 'failed' ? 'text-red-600' : 'text-muted-foreground'}`}>{t(`workspacePanel.${status}`, { defaultValue: status ?? '' })}</span>
        </div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1"><Clock3 className="h-3 w-3" />{duration}</span>
          <button type="button" onClick={() => snapshot?.revealOrigin(selectedKey)} className="inline-flex items-center gap-1 hover:text-foreground"><ArrowUpRight className="h-3 w-3" />{t('workspacePanel.agentOrigin', { defaultValue: 'Go to originating message' })}</button>
        </div>
        <SubagentPanel key={selectedKey} displayMode="panel" toolInput={selection.toolInput} toolResult={selection.toolResult} subagent={selection.subagent} activity={selection.subagentActivity} revealTarget={reveal} createDiff={createDiff} onFileOpen={snapshot?.onFileOpen} selectedProject={snapshot?.project} />
      </div> : <div className="px-3 py-8 text-center text-sm text-muted-foreground"><Bot className="mx-auto mb-3 h-6 w-6 opacity-50" />{t('workspacePanel.noAgents', { defaultValue: 'Agents spawned in this conversation will appear here with their actions and results.' })}</div>}
    </div>
  </div>;
}
