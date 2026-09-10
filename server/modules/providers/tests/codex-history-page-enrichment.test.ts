import assert from 'node:assert/strict';
import fs from 'node:fs';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';

test('Codex pages hydrate only visible agents and observe child-only updates without reparsing the parent', { concurrency: false }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-history-pages-'));
  const previousDatabasePath = process.env.DATABASE_PATH;
  const sessionId = 'synthetic-codex-paged-session';
  // Keep lookup traversal inside the isolated fixture, including date boundaries.
  const transcriptDirectory = path.join(directory, 'sessions', '2026', '01', '01');
  const transcriptPath = path.join(transcriptDirectory, `rollout-${sessionId}.jsonl`);
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'test.db');
  try {
    await writeFile(process.env.DATABASE_PATH, '');
    await initializeDatabase();
    await mkdir(transcriptDirectory, { recursive: true });
    const rows: Record<string, unknown>[] = [];
    const add = (type: string, payload: unknown) => rows.push({
      type, payload, timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, rows.length)).toISOString(),
    });
    add('session_meta', { id: sessionId, cwd: directory });
    add('event_msg', { type: 'user_message', message: 'Inspect these synthetic files' });
    const agentCount = 48;
    const activityCount = 1000;
    const agentPaths = new Set<string>();
    for (let agent = 0; agent < agentCount; agent++) {
      const agentId = `synthetic-agent-${agent}`;
      add('response_item', { type: 'function_call', name: 'spawn_agent', call_id: `call-${agent}`, arguments: JSON.stringify({ task_name: `task_${agent}`, description: `Synthetic task ${agent}` }) });
      add('event_msg', { type: 'sub_agent_activity', kind: 'started', event_id: `call-${agent}`, agent_thread_id: agentId, agent_path: `/root/task_${agent}` });
      const agentPath = path.join(transcriptDirectory, `rollout-${agentId}.jsonl`);
      agentPaths.add(agentPath);
      const activities = Array.from({ length: activityCount }, (_, index) => ({
        type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `Activity ${index}: ${'synthetic output '.repeat(8)}` }] },
      }));
      await writeFile(agentPath, [
        { type: 'session_meta', payload: { id: agentId, agent_nickname: `Agent ${agent}` } },
        { type: 'turn_context', payload: { model: 'synthetic-model' } },
        ...activities,
      ].map(row => JSON.stringify(row)).join('\n') + '\n');
    }
    add('event_msg', { type: 'task_started', turn_id: 'latest-turn' });
    add('event_msg', { type: 'user_message', message: 'Latest prompt' });
    add('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Latest answer' }] });
    add('event_msg', { type: 'token_count', info: { total_token_usage: { total_tokens: 123 }, model_context_window: 200000 } });
    await writeFile(transcriptPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    sessionsDb.createSession(sessionId, 'codex', directory, 'Synthetic fixture', '2026-01-01', '2026-01-01', transcriptPath);
    const streams: string[] = [];
    const original = fs.createReadStream;
    t.mock.method(fs, 'createReadStream', (...args: Parameters<typeof fs.createReadStream>) => {
      streams.push(String(args[0]));
      return original(...args);
    });
    const startedAt = performance.now();
    const latest = await sessionsService.fetchHistory(sessionId, { limit: 2 });
    const childReads = streams.filter(file => agentPaths.has(file)).length;
    t.diagnostic(`Synthetic cold latest page: ${(performance.now() - startedAt).toFixed(1)} ms; ${childReads} child files opened (${agentCount * activityCount} unrelated activities).`);
    assert.equal(childReads, 0);
    assert.equal(latest.total, agentCount + 3);
    assert.deepEqual(latest.messages.map(message => message.content), ['Latest prompt', 'Latest answer']);
    assert.equal(latest.messages[0].transcriptAnchorId, 'latest-turn');
    assert.deepEqual(latest.tokenUsage, { used: 123, total: 200000 });

    streams.length = 0;
    const warmStart = performance.now();
    await sessionsService.fetchHistory(sessionId, { limit: 2 });
    t.diagnostic(`Synthetic warm latest page: ${(performance.now() - warmStart).toFixed(1)} ms; ${streams.length} transcript files opened.`);
    assert.equal(streams.length, 0);

    const older = await sessionsService.fetchHistory(sessionId, { limit: 1, offset: 2 });
    assert.equal(streams.filter(file => agentPaths.has(file)).length, 1);
    assert.ok(!streams.includes(transcriptPath));
    const agent = older.messages[0];
    assert.equal(agent.subagent?.id, 'synthetic-agent-47');
    assert.equal(agent.subagent?.name, 'Agent 47');
    assert.equal(agent.subagent?.model, 'synthetic-model');
    assert.equal(agent.subagent?.activityCount, activityCount);
    assert.equal(agent.subagentTools?.length, 200);
    assert.equal(older.total, latest.total);
    assert.equal(older.hasMore, true);

    await appendFile(path.join(transcriptDirectory, 'rollout-synthetic-agent-47.jsonl'), JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fresh synthetic activity' }] } }) + '\n');
    const updated = await sessionsService.fetchHistory(sessionId, { limit: 1, offset: 2 });
    assert.equal(updated.messages[0].subagent?.activityCount, activityCount + 1);
    assert.equal(agent.subagent?.activityCount, activityCount, 'hydration must not mutate an earlier response or cached base');
    streams.length = 0;
    const remapped = await new CodexSessionsProvider().enrichHistoryPage(sessionId, [agent], 'different-native-branch');
    assert.equal(streams.length, 0);
    assert.equal(remapped[0], agent);

    const all = await sessionsService.fetchHistory(sessionId, { limit: null });
    assert.equal(all.messages.length, latest.total);
    assert.equal(all.messages.filter(message => message.subagentTools?.length).length, agentCount);
    assert.equal(all.messages.at(-2)?.transcriptAnchorId, 'latest-turn');
  } finally {
    t.mock.restoreAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(directory, { recursive: true, force: true });
  }
});
