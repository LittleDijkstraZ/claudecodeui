import { Bot } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { getSubagentStatus } from '@/shared/utils';
import { useWorkspacePanelActions, useWorkspacePanels } from '@/modules/workspace-panels/context/WorkspacePanelsContext';

/** Used by chat's composer area for a compact link to the detailed Agents panel. */
export function AgentsStatus() {
  const { t } = useTranslation('common');
  const state = useWorkspacePanels();
  const actions = useWorkspacePanelActions();
  const messages = state?.agents?.messages ?? [];
  if (messages.length === 0) return null;
  const running = messages.filter(message => getSubagentStatus(message) === 'running').length;
  return <button type="button" onClick={() => actions?.openPanel('agents')} className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground" title={t('workspacePanel.agents', { defaultValue: 'Agents' })}>
    <Bot className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{running > 0 ? t('workspacePanel.agentsRunning', { count: running, defaultValue: '{{count}} agents running' }) : t('workspacePanel.agentsRecorded', { count: messages.length, defaultValue: '{{count}} agents' })}</span>
    {running > 0 && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-violet-500" />}
  </button>;
}
