import { open } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

/** Extract only explicitly typed native title records; prompt text is never guessed to be an AI title. */
export function readClaudeTitleRecords(content: string, providerSessionId: string) {
  let automaticTitle: string | null = null;
  let renamedTitle: string | null = null;
  for (const line of content.split(/\r?\n/)) {
    let record: Record<string, unknown>;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.sessionId !== providerSessionId) continue;
    if (record.type === 'ai-title' && typeof record.aiTitle === 'string') automaticTitle = record.aiTitle;
    if (record.type === 'custom-title' && typeof record.customTitle === 'string') renamedTitle = record.customTitle;
  }
  return { automaticTitle, renamedTitle };
}

/** Metadata-only view for the Chat and Shell identity popover. It never starts a Claude process. */
export async function readClaudeSessionIdentity(sessionId: string) {
  const row = sessionsDb.getSessionById(sessionId);
  if (!row || row.provider !== 'claude') throw new AppError('This Claude session is unavailable on this remote.', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
  const base = { sessionId, providerSessionId: row.provider_session_id, projectPath: row.project_path,
    cloudcliName: row.custom_name || null, automaticTitle: null as string | null, renamedTitle: null as string | null,
    titleCoverage: 'unavailable' as 'complete' | 'recent' | 'unavailable' };
  if (!row.jsonl_path || !row.provider_session_id) return base;
  let file;
  try {
    file = await open(row.jsonl_path, 'r');
    const { size } = await file.stat();
    // Titles normally live near the tail. Bound the optional popover read on very long experiments.
    const start = Math.max(0, size - 4 * 1024 * 1024);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    let content = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) content = content.slice(content.indexOf('\n') + 1);
    const current = sessionsDb.getSessionById(sessionId);
    if (current?.provider_session_id !== row.provider_session_id || current?.jsonl_path !== row.jsonl_path) throw new AppError('The session changed while reading its identity. Reopen the details.', { code: 'SESSION_IDENTITY_STALE', statusCode: 409 });
    return { ...base, ...readClaudeTitleRecords(content, row.provider_session_id), titleCoverage: start ? 'recent' as const : 'complete' as const };
  } catch (error) {
    if (error instanceof AppError) throw error;
    return base;
  } finally { await file?.close(); }
}
