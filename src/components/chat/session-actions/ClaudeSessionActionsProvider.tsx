import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { ChatMessage } from '../types/types';

import { getClaudeSessionCapabilities, type ClaudeSessionCapabilities, type RewindResult } from './claudeSessionActionsApi';
import ClaudeSessionActionDialog from './ClaudeSessionActionDialog';
import { ClaudeSessionActionsContext } from './ClaudeSessionActionsContext';
import { savedClaudeMessageId } from './claudeSessionActionChecks';

type ActionSelection = { type: 'sideChat' | 'rewind'; sessionId: string; messageId: string; message: string };

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
  const [loaded, setLoaded] = useState<{ sessionId: string; data: ClaudeSessionCapabilities } | null>(null);
  const [error, setError] = useState<{ sessionId: string; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshRevision, setRefreshRevision] = useState(0);
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
    Boolean(savedClaudeMessageId(message.id, userOnly ? capabilities?.userMessageIds ?? [] : capabilities?.messageIds ?? []))
  ), [capabilities]);

  const open = useCallback((type: 'sideChat' | 'rewind', message: ChatMessage) => {
    if (!sessionId) return;
    const busy = isProcessing || capabilities?.isBusy;
    if (busy && (type === 'rewind' || !capabilities?.sideChatWhileRunning)) return;
    const messageId = savedClaudeMessageId(message.id, type === 'rewind' ? capabilities?.userMessageIds ?? [] : capabilities?.messageIds ?? []);
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
