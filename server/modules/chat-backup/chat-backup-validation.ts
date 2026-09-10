import { AppError } from '@/shared/index.js';
import type { ChatBackupBundle } from '@/shared/index.js';

const MAX_BYTES = 64 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalid(message: string): never {
  throw new AppError(message, { code: 'BACKUP_INVALID', statusCode: 400 });
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Backup contains an invalid object.');
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string, maximum = 4096, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > maximum || value.includes('\0')) {
    invalid(`Backup ${name} is invalid.`);
  }
  return value;
}

/** Used by the backup service before reading or writing portable sidecar names. */
export function validateBackupFilePath(value: unknown, provider: 'claude' | 'codex'): string {
  const name = string(value, 'file path', 512);
  const parts = name.split('/');
  if (parts.length > 8 || parts.some(part => !/^[a-zA-Z0-9._-]+$/.test(part) || part === '.' || part === '..')) {
    invalid('Backup file paths must be safe relative names.');
  }
  if (name === 'main.jsonl') return name;
  if (provider !== 'claude' || !(
    (name.startsWith('subagents/') && /\.(?:jsonl|meta\.json)$/.test(name))
    || (name.startsWith('tool-results/') && /\.(?:txt|json|jsonl)$/.test(name))
  )) invalid('Backup contains an unsupported file.');
  return name;
}

/** Used by restore and export to reject corrupt, incomplete or oversized native bundles. */
export function validateChatBackupBundle(input: unknown): ChatBackupBundle {
  const root = object(input);
  if (root.format !== 'cloudcli-chat-backup' || root.version !== 1) invalid('Unsupported chat backup format or version.');
  const createdAt = string(root.createdAt, 'date', 50);
  if (!Number.isFinite(Date.parse(createdAt))) invalid('Backup date is invalid.');
  const source = object(root.session);
  if (source.provider !== 'claude' && source.provider !== 'codex') invalid('Only Claude and Codex backups can be restored.');
  const provider = source.provider;
  const providerSessionId = string(source.providerSessionId, 'native session id', 120);
  if (!UUID.test(providerSessionId)) invalid('Backup native session id must be a UUID.');
  const session: ChatBackupBundle['session'] = {
    id: string(source.id, 'session id', 120), provider,
    title: string(source.title, 'title', 4000, true),
    projectPath: string(source.projectPath, 'project path'), providerSessionId,
    model: source.model === null ? null : string(source.model, 'model', 500),
    effort: source.effort === null ? null : string(source.effort, 'effort', 100),
  };
  if (!Array.isArray(root.files) || !root.files.length || root.files.length > 512) invalid('Backup must contain 1–512 files.');
  const seen = new Set<string>();
  let bytes = 0;
  const files = root.files.map(value => {
    const file = object(value);
    const name = validateBackupFilePath(file.path, provider);
    if (seen.has(name)) invalid('Backup contains duplicate file paths.');
    seen.add(name);
    if (typeof file.content !== 'string') invalid('Backup file content must be text.');
    bytes += Buffer.byteLength(file.content, 'utf8');
    if (bytes > MAX_BYTES) throw new AppError('Chat backup exceeds 64 MB.', { code: 'BACKUP_TOO_LARGE', statusCode: 413 });
    return { path: name, content: file.content };
  });
  const main = files.find(file => file.path === 'main.jsonl');
  if (!main) invalid('Backup has no main transcript.');
  let hasConversation = false;
  let hasIdentity = false;
  for (const file of files) {
    // Tool output is opaque text even when its filename ends in .jsonl. Only
    // main/subagent transcripts follow the provider's native record schema.
    if (!file.path.endsWith('.jsonl') || file.path.startsWith('tool-results/')) continue;
    const lines = file.content.split('\n').filter(line => line.trim());
    if (lines.length > 500_000) invalid('Backup transcript has too many records.');
    for (const line of lines) {
      let row: Record<string, unknown>;
      try { row = object(JSON.parse(line)); } catch { invalid('Backup contains corrupt JSONL.'); }
      if (typeof row.type !== 'string') invalid('Backup transcript record has no type.');
      if (file.path !== 'main.jsonl') continue;
      if (provider === 'claude') {
        if (row.sessionId !== undefined && row.sessionId !== providerSessionId) invalid('Backup transcript belongs to a different session.');
        if (row.sessionId === providerSessionId) hasIdentity = true;
        if (row.type === 'user' || row.type === 'assistant') {
          const message = object(row.message);
          if (typeof row.uuid !== 'string' || !UUID.test(row.uuid)) invalid('Claude messages must have native UUIDs.');
          if (message.role !== row.type || !(typeof message.content === 'string' || Array.isArray(message.content))) invalid('Claude message is invalid.');
          hasConversation = true;
        }
      } else {
        const payload = object(row.payload);
        if (row.type === 'session_meta') {
          if (payload.id !== providerSessionId) invalid('Backup transcript belongs to a different thread.');
          hasIdentity = true;
        }
        // Event messages alone can render in CloudCLI but cannot resume native context.
        if (row.type === 'response_item' && payload.type === 'message' && (payload.role === 'user' || payload.role === 'assistant')) {
          if (!Array.isArray(payload.content)) invalid('Codex message is invalid.');
          hasConversation = true;
        }
      }
    }
  }
  if (!hasIdentity) invalid('Backup has no native session identity.');
  if (!hasConversation) throw new AppError('This session has no saved conversation yet.', { code: 'BACKUP_EMPTY', statusCode: 409 });
  const bundle: ChatBackupBundle = { format: 'cloudcli-chat-backup', version: 1, createdAt, session, files };
  if (Buffer.byteLength(JSON.stringify(bundle), 'utf8') > MAX_BYTES) {
    throw new AppError('Chat backup exceeds 64 MB.', { code: 'BACKUP_TOO_LARGE', statusCode: 413 });
  }
  return bundle;
}
