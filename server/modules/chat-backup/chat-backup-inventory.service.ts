import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { ChatBackupInventoryPage, ChatBackupSessionSnapshot, LLMProvider } from '@/shared/index.js';

import { validateBackupFilePath } from './chat-backup-validation.js';

type InventoryDependencies = {
  sessions: Pick<typeof sessionsDb, 'getBackupSessionsPage'>;
  runningSessionIds: () => string[];
};
type InventoryRow = ReturnType<typeof sessionsDb.getBackupSessionsPage>['sessions'][number];
type HistoryVersion = Pick<ChatBackupSessionSnapshot, 'history' | 'contentVersion'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const identity = (row: InventoryRow) => JSON.stringify([row.session_id, row.provider, row.provider_session_id, row.jsonl_path, row.project_path]);
const timestamp = (value: string | null): string | null => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

async function historyVersion(row: InventoryRow, providerHome: (provider: 'claude' | 'codex') => string): Promise<HistoryVersion> {
  if (row.provider !== 'claude' && row.provider !== 'codex') return { history: 'unsupported', contentVersion: null };
  if (!row.provider_session_id && !row.jsonl_path) return { history: 'empty', contentVersion: null };
  if (!row.provider_session_id || !UUID.test(row.provider_session_id) || !row.jsonl_path || !row.project_path) return { history: 'unavailable', contentVersion: null };
  const provider = row.provider;
  try {
    const root = await fs.realpath(providerHome(provider));
    const records: Array<[string, string]> = [];
    let directories = 0;
    let entries = 0;
    const insideRoot = async (filename: string) => {
      const relative = path.relative(root, await fs.realpath(filename));
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Outside provider storage');
    };
    const add = async (filename: string, portablePath: string) => {
      validateBackupFilePath(portablePath, provider);
      if (records.length >= 512) throw new Error('Too many backup files');
      const stat = await fs.lstat(filename, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Not a regular backup file');
      await insideRoot(filename);
      records.push([portablePath, `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`]);
    };
    await add(row.jsonl_path, 'main.jsonl');
    if (provider === 'claude') {
      const sidecarRoot = row.jsonl_path.replace(/\.jsonl$/, '');
      const visit = async (directory: string, prefix: string, depth: number): Promise<void> => {
        let stat;
        try { stat = await fs.lstat(directory); } catch (error) { if (missing(error)) return; throw error; }
        if (!stat.isDirectory() || stat.isSymbolicLink() || depth > 7 || ++directories > 512) throw new Error('Invalid backup directory');
        await insideRoot(directory);
        // Iterate with a cap rather than materializing an unbounded directory.
        for await (const entry of await fs.opendir(directory)) {
          if (++entries > 4096 || entry.isSymbolicLink()) throw new Error('Invalid backup sidecar');
          const portable = `${prefix}/${entry.name}`;
          if (entry.isDirectory()) await visit(path.join(directory, entry.name), portable, depth + 1);
          else if ((prefix.startsWith('subagents') && /\.(?:jsonl|meta\.json)$/.test(entry.name)) || (prefix.startsWith('tool-results') && /\.(?:txt|json|jsonl)$/.test(entry.name))) {
            await add(path.join(directory, entry.name), portable);
          }
        }
      };
      await visit(path.join(sidecarRoot, 'subagents'), 'subagents', 1);
      await visit(path.join(sidecarRoot, 'tool-results'), 'tool-results', 1);
    }
    records.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return { history: 'native', contentVersion: createHash('sha256').update(JSON.stringify([identity(row), records])).digest('hex') };
  } catch {
    // Missing, changing or unsafe storage is retryable inventory state, never
    // a reason to expose provider filesystem paths or fail other conversations.
    return { history: 'unavailable', contentVersion: null };
  }
}

/** Chat Backup's service and isolated tests use this metadata-only inventory.
 * It reads no transcript contents and never calls a provider. At most eight
 * sessions inspect their bounded native file trees concurrently. */
export function createChatBackupInventoryService(
  providerHome: (provider: 'claude' | 'codex') => string,
  overrides: Partial<InventoryDependencies> = {},
) {
  const dependencies: InventoryDependencies = {
    sessions: sessionsDb,
    runningSessionIds: () => chatRunRegistry.listRunningRuns().map(run => run.sessionId),
    ...overrides,
  };
  return async (input: Parameters<typeof sessionsDb.getBackupSessionsPage>[0]): Promise<ChatBackupInventoryPage> => {
    const page = dependencies.sessions.getBackupSessionsPage(input);
    const versions = new Map<string, HistoryVersion>();
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(8, page.sessions.length) }, async () => {
      while (next < page.sessions.length) {
        const row = page.sessions[next++];
        versions.set(row.session_id, await historyVersion(row, providerHome));
      }
    }));
    // Native IDs can be assigned/replaced while filesystem metadata is read.
    // Recheck in one DB batch, returning fresh title/archive/model state and
    // refusing a content version derived from the previous native identity.
    const latest = dependencies.sessions.getBackupSessionsPage({ sessionIds: page.sessions.map(row => row.session_id) });
    const original = new Map(page.sessions.map(row => [row.session_id, row]));
    const running = new Set(dependencies.runningSessionIds());
    const sessions: ChatBackupSessionSnapshot[] = latest.sessions.map(row => ({
      sessionId: row.session_id, provider: row.provider as LLMProvider,
      title: row.custom_name?.trim() || 'Untitled Session',
      projectId: row.project_id, projectPath: row.project_path,
      model: row.model, effort: row.effort, isArchived: Boolean(row.isArchived),
      updatedAt: timestamp(row.updated_at), runtimeStatus: running.has(row.session_id) ? 'running' : 'idle',
      ...(identity(row) === identity(original.get(row.session_id)!)
        ? versions.get(row.session_id)!
        : { history: 'unavailable' as const, contentVersion: null }),
    }));
    return {
      sessions, nextCursor: page.nextCursor,
      missingSessionIds: input.sessionIds ? [...new Set([...page.missingSessionIds, ...latest.missingSessionIds])] : [],
    };
  };
}
