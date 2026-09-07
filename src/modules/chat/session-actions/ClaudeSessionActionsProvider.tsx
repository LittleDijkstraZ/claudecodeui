import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { ChatMessage, ClaudeSessionCapabilities, RewindResult } from '@/shared/types';
import { getClaudeSessionCapabilities } from '@/shared/api';
import ClaudeSessionActionDialog from '@/modules/chat/modals/ClaudeSessionActionDialog';
import { ClaudeSessionActionsContext } from '@/modules/chat/session-actions/ClaudeSessionActionsContext';
import { savedClaudeMessageId } from '@/modules/chat/session-actions/claudeSessionActionChecks';

type ActionSelection = { type: 'sideChat' | 'rewind'; sessionId: string; messageId: string; message: string };

/** Used by chat's ChatInterface to own saved-message actions independently of virtualized rows. */
export function ClaudeSessionActionsProvider({ children, sessionId, provider, isProcessing, revision, onRewound }: {
  children: ReactNode;
  sessionId: string | null;
  provider: string;
  isProcessing: boolean;
  revision: string;
  onRewound: (result: RewindResult) => Promise<void>;
}) {
  const { t } = useTranslation('chat');
  const enabled = provider === 'claude' && Boolean(sessionId);
  // Keep capability data scoped to its originating session.
  const [loaded, setLoaded] = useState<{ sessionId: string; data: ClaudeSessionCapabilities } | null>(null);
  // Show capability failures only for the session that requested them.
  const [error, setError] = useState<{ sessionId: string; message: string } | null>(null);
  // Disable saved-message actions until their remote capability request finishes.
  const [loading, setLoading] = useState(false);
  // Request fresh capabilities when a message menu opens or context changes.
  const [refreshRevision, setRefreshRevision] = useState(0);
  // Keep the confirmation dialog mounted when its original message row disappears.
  const [selection, setSelection] = useState<ActionSelection | null>(null);
  const capabilities = loaded?.sessionId === sessionId ? loaded.data : null;
  const refresh = useCallback(() => setRefreshRevision(value => value + 1), []);

  useEffect(() => {
    if (!enabled || !sessionId) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void getClaudeSessionCapabilities(sessionId, controller.signal).then(data => {
      if (!controller.signal.aborted) setLoaded({ sessionId, data });
    }).catch(reason => {
      if (!controller.signal.aborted) setError({ sessionId, message: reason instanceof Error ? reason.message : String(reason) });
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [enabled, sessionId, isProcessing, revision, refreshRevision]);

  const isSavedMessage = useCallback((message: ChatMessage, userOnly = false) => (
    Boolean(savedClaudeMessageId(message.transcriptAnchorId ?? message.id, userOnly ? capabilities?.userMessageIds ?? [] : capabilities?.messageIds ?? []))
  ), [capabilities]);

  const open = useCallback((type: 'sideChat' | 'rewind', message: ChatMessage) => {
    if (!sessionId) return;
    const busy = isProcessing || capabilities?.isBusy;
    if (busy && (type === 'rewind' || !capabilities?.sideChatWhileRunning)) return;
    const messageId = savedClaudeMessageId(message.transcriptAnchorId ?? message.id, type === 'rewind' ? capabilities?.userMessageIds ?? [] : capabilities?.messageIds ?? []);
    if (!messageId) return;
    setSelection({ type, sessionId, messageId, message: String(message.content ?? '') });
  }, [sessionId, isProcessing, capabilities]);

  const status = isProcessing || capabilities?.isBusy ? t(capabilities?.sideChatWhileRunning ? 'sessionActions.branchWhileRunning' : 'sessionActions.busy')
    : error?.sessionId === sessionId ? error.message
      : loading && !capabilities ? t('sessionActions.loading') : null;
  const value = useMemo(() => ({
    enabled, capabilities, busy: isProcessing || Boolean(capabilities?.isBusy), status, isSavedMessage, open, refresh,
  }), [enabled, capabilities, isProcessing, status, isSavedMessage, open, refresh]);

  return (
    <ClaudeSessionActionsContext.Provider value={value}>
      {children}
      {selection && selection.sessionId === sessionId && (
        <ClaudeSessionActionDialog
          key={`${selection.type}-${selection.sessionId}-${selection.messageId}`}
          {...selection}
          onClose={() => setSelection(null)}
          onRewound={async result => { await onRewound(result); refresh(); }}
        />
      )}
    </ClaudeSessionActionsContext.Provider>
  );
}
