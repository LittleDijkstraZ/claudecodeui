import { Bot, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { getSubagentStatus } from '@/shared/utils';
import type { ChatMessage } from '@/shared/types';
import { useWorkspacePanelActions } from '@/modules/workspace-panels';
import { getIntrinsicMessageKey } from '@/modules/chat/utils/messageKeys';

/** Used by chat's live transcript to link a spawned agent to its dedicated workspace detail. */
export function AgentSummary({ message }: { message: ChatMessage }) {
  const { t } = useTranslation('common');
  const actions = useWorkspacePanelActions();
  const key = getIntrinsicMessageKey(message);
  const status = getSubagentStatus(message);
  const title = message.subagent?.name || message.subagent?.type || t('workspacePanel.agent', { defaultValue: 'Agent' });
  return <button type="button" disabled={!key} onClick={() => key && actions?.openAgent(key)} className="my-1 flex w-full min-w-0 items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-left text-xs hover:bg-muted/50">
    <Bot className="h-4 w-4 shrink-0 text-violet-500" />
    <span className="min-w-0 flex-1"><span className="block truncate font-medium">{title}</span>{message.subagent?.description && <span className="block truncate text-[11px] text-muted-foreground">{message.subagent.description}</span>}</span>
    <span className={`shrink-0 text-[10px] ${status === 'failed' ? 'text-red-600' : 'text-muted-foreground'}`}>{t(`workspacePanel.${status}`, { defaultValue: status })}</span>
    {status === 'running' && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-violet-500" />}
    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
  </button>;
}
