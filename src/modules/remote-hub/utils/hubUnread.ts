type UnreadRecord = Record<string, { eventId: string; unread: boolean; manual?: boolean }>;
const key = (remoteId: string) => `cloudcli-hub-unread:${encodeURIComponent(remoteId)}`;
function read(remoteId: string): UnreadRecord {
  try {
    const value = JSON.parse(localStorage.getItem(key(remoteId)) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, record]) => record && typeof record === 'object' && typeof (record as { eventId?: unknown }).eventId === 'string' && typeof (record as { unread?: unknown }).unread === 'boolean')) as UnreadRecord;
  } catch { return {}; }
}
function save(remoteId: string, records: UnreadRecord) {
  try { localStorage.setItem(key(remoteId), JSON.stringify(Object.fromEntries(Object.entries(records).slice(-1000)))); } catch { /* Read state remains usable in this window when storage is full. */ }
}
/** Completion identifiers prevent a replay after reconnect from making an already read reply unread. */
export function recordHubUnread(remoteId: string, sessionId: string, eventId: string) {
  const records = read(remoteId);
  if (records[sessionId]?.eventId !== eventId) { records[sessionId] = { ...records[sessionId], eventId, unread: true }; save(remoteId, records); }
  return getHubUnread(remoteId);
}
export function getHubUnread(remoteId: string) {
  return Object.entries(read(remoteId)).filter(([, record]) => record?.unread === true).map(([id]) => id);
}
/** Used by the hub connection hook to restore attention without inventing a completion event. */
export function markHubConversationUnread(remoteId: string, sessionId: string) {
  const records = read(remoteId);
  records[sessionId] = { eventId: records[sessionId]?.eventId ?? '', unread: true, manual: true };
  save(remoteId, records);
}

export function readHubConversation(remoteId: string, sessionId: string, automatic = false) {
  const records = read(remoteId);
  if (automatic && records[sessionId]?.manual) return false;
  if (records[sessionId]) { records[sessionId].unread = false; delete records[sessionId].manual; save(remoteId, records); }
  return true;
}
