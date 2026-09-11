import { useMemo } from 'react';
import { Bot, ChevronRight, Workflow } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ChatMessage } from '@/shared/types';
import { useWorkspacePanelActions, useWorkspacePanels } from '@/modules/workspace-panels';
import { getIntrinsicMessageKey } from '@/modules/chat/utils/messageKeys';
import { deriveConversationTasks } from '@/modules/chat/agents/conversationTasks';

/** Used by chat's live transcript to open recorded agent and workflow details in the workspace. */
export function AgentSummary({ message }: { message: ChatMessage }) {
  const { t } = useTranslation('common');
  const actions = useWorkspacePanelActions();
  const snapshot = useWorkspacePanels()?.agents;
  const key = getIntrinsicMessageKey(message);
  const task = useMemo(() => deriveConversationTasks([message], snapshot?.records ?? [], snapshot?.activity ?? null, snapshot?.sessionId)[0], [message, snapshot?.records, snapshot?.activity, snapshot?.sessionId]);
  const status = task?.status ?? 'unknown';
  const isWorkflow = message.toolName === 'Workflow';
  const title = task?.title || t('workspacePanel.agent', { defaultValue: 'Agent' });
  const description = task?.progress || task?.description;
  return <button type="button" disabled={!key} onClick={() => key && actions?.openAgent(key)} className="group my-1 flex w-full min-w-0 items-center gap-2.5 rounded-xl border border-border/60 bg-muted/20 px-3 py-2.5 text-left text-xs transition-colors hover:border-primary/30 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${isWorkflow ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400' : 'bg-violet-500/10 text-violet-600 dark:text-violet-400'}`}>{isWorkflow ? <Workflow className="h-4 w-4" /> : <Bot className="h-4 w-4" />}</span>
    <span className="min-w-0 flex-1"><span className="block truncate font-medium">{title}</span>{description && <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{description}</span>}</span>
    <span className={`shrink-0 text-[10px] ${status === 'failed' ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'}`}>{t(`workspacePanel.${status}`, { defaultValue: status === 'unknown' ? 'Status unconfirmed' : status })}</span>
    {status === 'running' && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-blue-500" />}
    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
  </button>;
}
