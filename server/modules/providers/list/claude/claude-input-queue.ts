import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import type { AnyRecord } from '@/shared/index.js';

type Entry = { responseMessageId?: string; transcriptAnchorId?: string; images?: unknown; files?: unknown; id: string; command: string; timestamp: string; delivery: 'queued' | 'delivered' | 'failed'; processed: boolean; initial: boolean };

/** The Claude runtime owns one pushable stdin iterable for the entire native process. */
export function createClaudeInputQueue(onDelivery: (entry: Entry, error?: string) => void) {
  const entries = new Map<string, Entry>();
  const pending: Array<{ entry: Entry; messages: SDKUserMessage[] | null }> = [];
  let closed = false;
  let preparing = 0;
  let wake: (() => void) | null = null;
  const notify = () => { wake?.(); wake = null; };
  const begin = (id: string, command: string, initial = false, attachments: { images?: unknown; files?: unknown } = {}) => {
    const existing = entries.get(id);
    if (existing) {
      if (existing.command !== command || JSON.stringify([existing.images ?? [], existing.files ?? []]) !== JSON.stringify([attachments.images ?? [], attachments.files ?? []])) throw new Error('This message identifier already belongs to a different message.');
      onDelivery(existing);
      return null;
    }
    if (closed) throw new Error('The existing Claude input stream has closed. This message was not submitted.');
    if ([...entries.values()].filter(entry => !entry.processed).length >= 64) throw new Error('The existing Claude input queue is full. Wait for a queued message to be handled.');
    const entry: Entry = { ...attachments, id, command, initial, timestamp: new Date().toISOString(), delivery: 'queued', processed: false };
    entries.set(id, entry); preparing++;
    const reserved: (typeof pending)[number] = { entry, messages: null };
    pending.push(reserved);
    onDelivery(entry);
    let settled = false;
    return {
      commit(messages: SDKUserMessage[]) {
        if (settled) return; settled = true; preparing--;
        if (closed) { entry.delivery = 'failed'; entry.processed = true; onDelivery(entry, 'Claude closed before this message could be submitted.'); return; }
        reserved.messages = messages.map(message => ({ ...message, uuid: id as SDKUserMessage['uuid'], timestamp: entry.timestamp, priority: 'next', origin: { kind: 'human' } }));
        notify();
      },
      fail(error: string) {
        if (settled) return; settled = true; preparing--; entry.delivery = 'failed'; entry.processed = true; onDelivery(entry, error); notify();
      },
    };
  };
  const stream = (async function* () {
    while (!closed) {
      const first = pending[0];
      if (first?.entry.delivery === 'failed') { pending.shift(); continue; }
      if (first?.messages) { pending.shift(); for (const message of first.messages) { if (closed) break; yield message; } continue; }
      await new Promise<void>(resolve => { wake = resolve; });
    }
  })();
  const observe = (message: AnyRecord) => {
    if (message.parent_tool_use_id || message.isSidechain || message.isSynthetic) return;
    const ids = new Set<string>();
    const consumedIds = new Set<string>();
    const isUserEcho = message.type === 'user' && !message.tool_use_result && !(Array.isArray(message.message?.content) && message.message.content.some((block: AnyRecord) => block.type === 'tool_result'));
    if (isUserEcho && typeof message.uuid === 'string') ids.add(message.uuid);
    if (typeof message.user_message_uuid === 'string') consumedIds.add(message.user_message_uuid);
    if (Array.isArray(message.user_message_uuids)) for (const id of message.user_message_uuids) if (typeof id === 'string') consumedIds.add(id);
    for (const id of consumedIds) ids.add(id);
    for (const id of ids) {
      const entry = entries.get(id);
      if (!entry || entry.delivery === 'failed') continue;
      // A consumption acknowledgement is not itself a saved user row. Bind a
      // checkpoint anchor only when an actual user echo supplies its UUID.
      const anchor = isUserEcho && typeof message.uuid === 'string'
        && (message.uuid === id || consumedIds.size === 1 && consumedIds.has(id) && !entries.has(message.uuid))
        ? message.uuid : undefined;
      const responseId = message.type === 'assistant' ? message.message?.id : message.type === 'stream_event' && message.event?.type === 'message_start' ? message.event.message?.id : undefined;
      // A batched reply acknowledges every input, but cannot identify one saved
      // user row. Never use that shared response to collapse distinct sends.
      const newResponse = consumedIds.size === 1 && !entry.responseMessageId && typeof responseId === 'string' ? responseId : undefined;
      const changed = entry.delivery !== 'delivered' || Boolean(anchor && anchor !== entry.transcriptAnchorId) || Boolean(newResponse);
      if (newResponse) entry.responseMessageId = newResponse;
      if (anchor) entry.transcriptAnchorId = anchor;
      entry.delivery = 'delivered';
      if (changed) onDelivery(entry);
      if (message.type === 'result') entry.processed = true;
    }
    // The first query result is the initial turn on older hosts that omit input UUIDs.
    // Never assign an uncorrelated Workflow result to a newer queued user message.
    if (message.type === 'result') for (const entry of entries.values()) if (entry.initial) entry.processed = true;
  };
  const release = (reason = 'Claude ended before confirming this message. Delivery is unknown; review the transcript before retrying.') => {
    if (closed) return;
    closed = true;
    for (const entry of entries.values()) if (entry.delivery === 'queued') { entry.delivery = 'failed'; entry.processed = true; onDelivery(entry, reason); }
    pending.length = 0; notify();
  };
  return { stream, begin, observe, release, isOpen: () => !closed,
    hasPending: () => preparing > 0 || pending.length > 0 || [...entries.values()].some(entry => !entry.initial && !entry.processed),
    messageCount: () => entries.size,
    // Only explicit native receipt IDs can attribute command output; a Workflow result cannot.
    commandsForResult: (message: AnyRecord): string[] => {
      if (message.type !== 'result' || message.parent_tool_use_id || message.isSidechain) return [];
      const ids = new Set([message.user_message_uuid, ...(Array.isArray(message.user_message_uuids) ? message.user_message_uuids : [])]);
      return [...ids].flatMap(id => typeof id === 'string' && entries.has(id) ? [entries.get(id)!.command] : []);
    },
    ownsUserEcho: (message: AnyRecord) => message.type === 'user' && !message.parent_tool_use_id && !message.isSidechain && !message.isSynthetic && !message.tool_use_result && (entries.has(message.uuid) || [...entries.values()].some(entry => entry.transcriptAnchorId === message.uuid)) && !(Array.isArray(message.message?.content) && message.message.content.some((block: AnyRecord) => block.type === 'tool_result')),
  };
}
