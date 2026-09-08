import assert from 'node:assert/strict';
import fs from 'node:fs';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import { claudeUsageService } from '@/modules/claude-usage/index.js';
import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

// Generated large transcripts only: no test reads the developer's Claude data.
test('a latest history page does not load unrelated agent logs; an older page hydrates its agents and sees child-only updates', { concurrency: false }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'claude-history-pages-'));
  const previousDatabasePath = process.env.DATABASE_PATH;
  const sessionId = 'synthetic-paged-session';
  const transcriptPath = path.join(directory, `${sessionId}.jsonl`);
  const childDirectory = path.join(directory, sessionId, 'subagents');
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'test.db');
  try {
    await writeFile(process.env.DATABASE_PATH!, '');
    await initializeDatabase();
    await mkdir(childDirectory, { recursive: true });
    const rows: Record<string, unknown>[] = [];
    let prior: string | null = null;
    const add = (type: string, uuid: string, message: unknown, extra = {}) => {
      rows.push({ type, uuid, parentUuid: prior, sessionId, timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, rows.length)).toISOString(), message, ...extra });
      prior = uuid;
    };
    add('user', 'old-user', { role: 'user', content: 'Inspect these synthetic files' });
    const agentCount = 48;
    const activityCount = 1000;
    for (let agent = 0; agent < agentCount; agent++) {
      const agentId = `agent-${agent}`;
      add('assistant', `call-${agent}`, { role: 'assistant', id: `api-${agent}`, content: [{ type: 'tool_use', id: `tool-${agent}`, name: 'Agent', input: { description: `Synthetic agent ${agent}` } }] });
      add('user', `launch-${agent}`, { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tool-${agent}`, content: 'Internal launch acknowledgement' }] }, { toolUseResult: { agentId, isAsync: true, description: `Synthetic agent ${agent}` } });
      const activities = Array.from({ length: activityCount }, (_, index) => ({ type: 'assistant', isSidechain: true, message: { role: 'assistant', model: 'synthetic-model', content: [{ type: 'text', text: `Activity ${index}: ${'synthetic output '.repeat(8)}` }] } }));
      await writeFile(path.join(childDirectory, `agent-${agentId}.jsonl`), activities.map(row => JSON.stringify(row)).join('\n') + '\n');
    }
    add('user', 'latest-user', { role: 'user', content: 'Latest prompt, same UUID on every read' });
    add('assistant', 'latest-answer', { role: 'assistant', id: 'api-latest', content: [{ type: 'text', text: 'Latest answer' }] });
    await writeFile(transcriptPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    sessionsDb.createSession(sessionId, 'claude', directory, 'Synthetic fixture', '2026-01-01', '2026-01-01', transcriptPath);
    // Existing old sessions have already imported accounting; preserve that ledger
    // while isolating the page renderer's unnecessary child-transcript work.
    const usageBefore = await claudeUsageService.getSnapshot(sessionId);
    const streams: string[] = [];
    const original = fs.createReadStream;
    t.mock.method(fs, 'createReadStream', (...args: Parameters<typeof fs.createReadStream>) => {
      streams.push(String(args[0]));
      return original(...args);
    });
    const startedAt = performance.now();
    const latest = await sessionsService.fetchHistory(sessionId, { limit: 2 });
    const childReads = streams.filter(file => file.startsWith(childDirectory)).length;
    t.diagnostic(`Synthetic latest page: ${(performance.now() - startedAt).toFixed(1)} ms, ${childReads} child files opened (${agentCount * activityCount} unrelated activities).`);
    assert.equal(childReads, 0, 'latest prose must not open any historical agent transcript');
    assert.equal(latest.total, agentCount + 3);
    assert.deepEqual(latest.messages.map(message => message.content), ['Latest prompt, same UUID on every read', 'Latest answer']);
    assert.equal(latest.messages[0].transcriptAnchorId, 'latest-user');
    assert.deepEqual(latest.messages[0].responseMessageIds, ['api-latest']);
    assert.deepEqual(latest.tokenUsage, usageBefore);

    streams.length = 0;
    const older = await sessionsService.fetchHistory(sessionId, { limit: 1, offset: 2 });
    assert.equal(streams.filter(file => file.startsWith(childDirectory)).length, 1);
    const agent = older.messages[0];
    assert.equal(agent.subagent?.id, 'agent-47');
    assert.equal(agent.subagent?.activityCount, activityCount);
    assert.equal(agent.subagent?.status, 'completed');
    assert.equal(agent.subagentTools?.length, 200);
    assert.equal(older.total, latest.total);
    assert.equal(older.hasMore, true);

    await appendFile(path.join(childDirectory, 'agent-agent-47.jsonl'), JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'still-running', name: 'Read', input: { file_path: '/synthetic/file' } }] } }) + '\n');
    const updated = await sessionsService.fetchHistory(sessionId, { limit: 1, offset: 2 });
    assert.equal(updated.messages[0].subagent?.status, 'running', 'a child-only append must not reuse stale parent-cache enrichment');
    assert.equal(updated.messages[0].subagent?.activityCount, activityCount + 1);
    assert.equal(agent.subagent?.status, 'completed', 'hydration must not mutate an earlier response or the cached base');

    streams.length = 0;
    const remapped = await new ClaudeSessionsProvider().enrichHistoryPage(sessionId, [agent], 'different-native-branch');
    assert.equal(streams.length, 0, 'an old page must not open children under a newly mapped native session');
    assert.equal(remapped[0], agent);

    const all = await sessionsService.fetchHistory(sessionId, { limit: null });
    assert.equal(all.messages.length, latest.total);
    assert.equal(all.messages.filter(message => message.subagentTools?.length).length, agentCount);
    assert.equal(all.messages.at(-2)?.transcriptAnchorId, 'latest-user');
  } finally {
    t.mock.restoreAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(directory, { recursive: true, force: true });
  }
});
