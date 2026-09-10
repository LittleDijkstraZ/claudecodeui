import path from 'node:path';
import { createHash } from 'node:crypto';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { generateDisplayName } from '@/modules/projects/index.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type { SessionUpsertedEvent } from '@/shared/types.js';

/**
 * The single producer of the `session_upserted` delta.
 *
 * The event carries everything a sidebar needs to upsert a session in place
 * (its summary plus the owning project's metadata), so clients never refetch
 * the whole project list because one transcript changed on disk.
 *
 * It used to be built in two places — the on-disk sessions watcher and the
 * chat run registry — and only the registry's copy set `providerSessionId`.
 * That field is how the client notices a row it is showing has been merged
 * into its canonical app-session row, so a merge announced by any other path
 * left a stale duplicate in the sidebar. One builder, one shape.
 */
async function buildSessionUpsertedEvent(
  sessionIdOrProviderSessionId: string,
  includeTranscript = false,
): Promise<SessionUpsertedEvent | null> {
  // Resolving by provider id first covers the watcher, which only ever sees
  // the id written in the transcript. For a row where the two ids are equal
  // — legacy rows, and any session indexed from disk before its mapping
  // existed — both lookups land on the same row anyway.
  const row = sessionsDb.getSessionByProviderSessionId(sessionIdOrProviderSessionId)
    ?? sessionsDb.getSessionById(sessionIdOrProviderSessionId);
  if (!row || row.isArchived) {
    return null;
  }

  const projectPath = row.project_path;
  const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;
  const displayName = project?.custom_project_name?.trim()
    ? project.custom_project_name
    : await generateDisplayName(path.basename(projectPath ?? '') || (projectPath ?? ''), projectPath);

  // Only disk-watcher updates inspect history. Renaming/allocating a session
  // remains metadata-only and cannot announce an old transcript as unread.
  let transcriptVersion: string | undefined;
  let messageCount = 0;
  if (includeTranscript && row.provider_session_id) {
    try {
      const history = await sessionsService.fetchHistory(row.session_id, { limit: 1, offset: 0 });
      messageCount = history.total;
      const last = history.messages.at(-1);
      if (last) {
        // Display IDs and enrichment can vary between reads; hash message content
        // and count so repeat filesystem events have the same unread identity.
        transcriptVersion = createHash('sha256').update(JSON.stringify([
          history.total, last.kind, last.role, last.content, last.text,
        ])).digest('hex');
      }
    } catch {
      // A partially written or unavailable transcript still gets its metadata update.
    }
  }

  return {
    ...(transcriptVersion ? { transcriptVersion } : {}),
    kind: 'session_upserted',
    sessionId: row.session_id,
    providerSessionId: row.provider_session_id ?? null,
    // The column is a plain TEXT and typed as `string` on the row, but only
    // provider adapters ever write it.
    provider: row.provider as SessionUpsertedEvent['provider'],
    session: {
      id: row.session_id,
      summary: row.custom_name || '',
      messageCount,
      lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
    },
    project: project
      ? {
        projectId: project.project_id,
        path: project.project_path,
        fullPath: project.project_path,
        displayName,
        isStarred: Boolean(project.isStarred),
      }
      : null,
    timestamp: new Date().toISOString(),
  };
}

function sendToConnectedClients(payloads: string[]): void {
  if (payloads.length === 0) {
    return;
  }

  connectedClients.forEach((client) => {
    if (client.readyState === WS_OPEN_STATE) {
      for (const payload of payloads) {
        client.send(payload);
      }
    }
  });
}

/** Announces one session. Used by the chat run registry when a run reports its provider-native id. */
export async function broadcastSessionUpserted(sessionIdOrProviderSessionId: string): Promise<void> {
  const event = await buildSessionUpsertedEvent(sessionIdOrProviderSessionId);
  if (event) {
    sendToConnectedClients([JSON.stringify(event)]);
  }
}

/**
 * Announces a batch of sessions. Used by the providers module's sessions
 * watcher, whose debounced flush can carry dozens of ids at once — the client
 * set is walked once for the whole batch rather than once per session.
 */
export async function broadcastSessionUpsertedBatch(
  sessionIds: Iterable<string>,
): Promise<void> {
  const payloads: string[] = [];
  for (const sessionId of sessionIds) {
    const event = await buildSessionUpsertedEvent(sessionId, true);
    if (event) {
      payloads.push(JSON.stringify(event));
    }
  }

  sendToConnectedClients(payloads);
}
