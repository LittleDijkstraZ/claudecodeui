import { useWorkspacePanelActions } from '@/modules/workspace-panels';
import type { NormalizedMessage } from '@/shared/types';

/** An explicit handoff entry after the owning remote refuses Chat because Shell owns the session. */
export function TerminalConflictNotice({ records, sessionId }: { records?: NormalizedMessage[]; sessionId: string | null }) {
  const actions = useWorkspacePanelActions();
  if (!sessionId) return null;
  const conflict = [...(records ?? [])].reverse().find(record => record.sessionId === sessionId && record.kind === 'status' && record.text === 'execution_conflict');
  if (!conflict || !actions) return null;
  const after = records?.slice((records.indexOf(conflict) ?? -1) + 1) ?? [];
  // A later delivered human turn supersedes the old refusal. An unmatched
  // restored copy has no known position and cannot establish that recovery.
  if (after.some(record => record.role === 'user' && !record.isUnlocatedLocalCopy && (!record.delivery || record.delivery === 'delivered'))) return null;
  const target = { sessionId, executionId: conflict.executionId, providerSessionId: typeof conflict.providerSessionId === 'string' ? conflict.providerSessionId : undefined };
  return <div role="status" className="mx-auto flex w-full max-w-4xl flex-wrap items-center gap-2 px-4 py-2 text-xs text-amber-700 dark:text-amber-400">
    <span>Chat 未接受这条消息：同一个 Claude 会话正由终端使用。</span>
    <button type="button" className="min-h-8 rounded px-2 underline underline-offset-2 hover:bg-accent" onClick={() => actions.revealTerminal(target)}>查看现有终端</button>
  </div>;
}
