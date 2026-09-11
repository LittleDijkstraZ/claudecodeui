import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ChatMessage, ServerEvent, SessionActivity } from '@/shared/types';

type Control = 'interrupt' | 'stop-task';
type PendingControl = { requestId: string; targetId: string; timer: ReturnType<typeof setTimeout> };
type ControlState = { sessionId: string | null; interrupt?: string; 'stop-task'?: string; interruptError?: string; stopTaskError?: string };

/** Used by ChatInterface to control the existing Claude process without resending prompts or changing task status optimistically. */
export function useClaudeTaskControls({ sessionId, activity, messages, sendMessage, subscribe }: {
  sessionId: string | null;
  activity: SessionActivity | null;
  messages: ChatMessage[];
  sendMessage: (message: unknown) => boolean | void;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
}) {
  const { t } = useTranslation('chat');
  // Keep pending controls and failures scoped to the conversation that issued them.
  const [state, setState] = useState<ControlState>({ sessionId });
  const pending = useRef(new Map<Control, PendingControl>());
  const current = useRef({ sessionId, activity, messages });
  useLayoutEffect(() => { current.current = { sessionId, activity, messages }; }, [sessionId, activity, messages]);
  // A conversation switch discards only its local control feedback, before paint.
  if (state.sessionId !== sessionId) setState({ sessionId });

  const settle = useCallback((control: Control, error?: string) => {
    const request = pending.current.get(control);
    if (!request) return;
    clearTimeout(request.timer);
    pending.current.delete(control);
    setState(previous => ({ ...previous, [control]: undefined, [control === 'interrupt' ? 'interruptError' : 'stopTaskError']: error }));
  }, []);

  useEffect(() => {
    const requests = pending.current;
    const unsubscribe = subscribe(event => {
      if (event.kind === 'websocket_reconnected') {
        for (const control of requests.keys()) settle(control, t('input.queue.controlUnconfirmed', { defaultValue: 'Confirmation was not received. Check the connection and current status before trying again.' }));
        return;
      }
      if (event.sessionId !== sessionId || event.kind !== 'status') return;
      const control = event.text === 'queued_input_interrupt' ? 'interrupt' : event.text === 'task_stop' ? 'stop-task' : null;
      if (!control) return;
      const request = requests.get(control);
      if (!request || event.requestId !== request.requestId) return;
      const targetId = control === 'interrupt' ? event.clientMessageId : event.taskId;
      if (targetId !== request.targetId) return;
      if (event.status === 'completed') settle(control);
      else if (event.status === 'failed') settle(control, typeof event.error === 'string' ? event.error : t('input.queue.controlFailed', { defaultValue: 'The action failed. Your queued messages remain available.' }));
    });
    return () => {
      unsubscribe();
      for (const request of requests.values()) clearTimeout(request.timer);
      requests.clear();
    };
  }, [sessionId, subscribe, settle, t]);

  const request = useCallback((control: Control, targetId: string) => {
    const context = current.current;
    if (!sessionId || context.sessionId !== sessionId || pending.current.has(control)) return;
    if (control === 'interrupt') {
      if (!context.activity?.canInterruptQueuedMessages || context.activity.acceptsInput !== true
        || !context.messages.some(message => message.clientMessageId === targetId && message.type === 'user' && message.delivery === 'queued')) return;
    } else if (!context.activity?.canStopTask) return;
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => settle(control, t('input.queue.controlUnconfirmed', { defaultValue: 'Confirmation was not received. Check the connection and current status before trying again.' })), 15_000);
    pending.current.set(control, { requestId, targetId, timer });
    setState(previous => ({ ...(previous.sessionId === sessionId ? previous : { sessionId }), [control]: targetId,
      [control === 'interrupt' ? 'interruptError' : 'stopTaskError']: undefined }));
    try {
      const sent = sendMessage({ type: `chat.${control}`, sessionId, requestId,
        ...(control === 'interrupt' ? { clientMessageId: targetId } : { taskId: targetId }) });
      if (sent === false) settle(control, t('input.queue.controlDisconnected', { defaultValue: 'Connection lost. Reconnect to try again; your queued messages have not been changed.' }));
    } catch {
      settle(control, t('input.queue.controlDisconnected', { defaultValue: 'Connection lost. Reconnect to try again; your queued messages have not been changed.' }));
    }
  }, [sessionId, sendMessage, settle, t]);

  const interruptQueuedMessage = useCallback((clientMessageId: string) => request('interrupt', clientMessageId), [request]);
  const stopTask = useCallback((taskId: string) => request('stop-task', taskId), [request]);
  const visibleState = state.sessionId === sessionId ? state : undefined;
  return { interruptQueuedMessage, stopTask, interruptingMessageId: visibleState?.interrupt ?? null,
    stoppingTaskId: visibleState?.['stop-task'] ?? null, interruptError: visibleState?.interruptError ?? null,
    taskStopError: visibleState?.stopTaskError ?? null };
}
