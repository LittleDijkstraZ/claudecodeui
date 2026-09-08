import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-provider-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const SESSION_ID = 'claude-session-1';
const AGENT_ID = 'a1b2c3d4e5f60718';
const AGENT_TOOL_USE_ID = 'toolu_agent_1';

test('native compact summaries preserve their classification for string, block-array and meta rows', () => {
  const provider = new ClaudeSessionsProvider();
  const summary = 'This session is being continued from a previous conversation.\nSynthetic summary fixture.';
  for (const content of [summary, [{ type: 'text', text: summary.split('\n')[0] }, { type: 'text', text: summary.split('\n')[1] }]]) {
    for (const isMeta of [false, true]) {
      const raw = { type: 'user', uuid: 'native-compact-fixture', timestamp: '2026-09-08T20:38:02Z',
        isCompactSummary: true, isMeta, message: { role: 'user', content } };
      const original = JSON.stringify(raw);
      const messages = provider.normalizeMessage(raw, SESSION_ID);
      assert.equal(messages.length, 1, 'A native summary is one artifact regardless of text block count.');
      assert.equal(messages[0].role, 'assistant');
      assert.equal(messages[0].isCompactSummary, true);
      assert.equal(messages[0].content, summary);
      assert.equal(messages[0].id, raw.uuid);
      assert.equal(messages[0].timestamp, raw.timestamp);
      assert.equal(messages[0].transcriptAnchorId, undefined, 'A synthetic summary is not an editable user prompt.');
      assert.equal(JSON.stringify(raw), original, 'Normalization does not mutate native metadata or content.');
    }
  }
});

test('ordinary user text quoting a compact-summary prefix remains a genuine anchored user message', () => {
  const provider = new ClaudeSessionsProvider();
  const text = 'This session is being continued from a previous conversation. Please explain this quoted text.';
  for (const content of [text, [{ type: 'text', text }]]) {
    const [message] = provider.normalizeMessage({ type: 'user', uuid: 'quoted-user-fixture',
      message: { role: 'user', content } }, SESSION_ID);
    assert.equal(message.role, 'user');
    assert.equal(message.content, text);
    assert.equal(message.isCompactSummary, undefined);
    assert.equal(message.transcriptAnchorId, 'quoted-user-fixture');
  }
});

test('saved assistant text preserves API identity without inventing global block indices from split rows', () => {
  const provider = new ClaudeSessionsProvider();
  const rows = [
    { type: 'assistant', uuid: 'native-first-block', message: { id: 'same-api-reply', role: 'assistant', content: [{ type: 'text', text: 'First' }] } },
    { type: 'assistant', uuid: 'native-second-block', message: { id: 'same-api-reply', role: 'assistant', content: [{ type: 'text', text: 'Second' }] } },
    { type: 'assistant', uuid: 'native-string-row', message: { id: 'string-api-reply', role: 'assistant', content: 'String form' } },
    { type: 'assistant', uuid: 'native-no-api-row', message: { role: 'assistant', content: [{ type: 'text', text: 'Legacy' }] } },
  ];
  const messages = rows.flatMap(raw => provider.normalizeMessage(raw, SESSION_ID));
  assert.deepEqual(messages.map(message => [message.id, message.responseMessageId]), [
    ['native-first-block_0', 'same-api-reply'], ['native-second-block_0', 'same-api-reply'],
    ['native-string-row', 'string-api-reply'], ['native-no-api-row_0', undefined],
  ]);
  assert.ok(messages.every(message => message.contentBlockIndex === undefined));
  assert.ok(messages.every(message => message.transcriptAnchorId === undefined));
});

test('stream identity accepts exact zero-based indices and leaves unavailable metadata absent', () => {
  const provider = new ClaudeSessionsProvider();
  for (const type of ['content_block_delta', 'content_block_stop']) {
    const [valid] = provider.normalizeMessage({ type, delta: { text: 'fixture' }, responseMessageId: 'api-zero', contentBlockIndex: 0 }, SESSION_ID);
    assert.equal(valid.responseMessageId, 'api-zero');
    assert.equal(valid.contentBlockIndex, 0);
    assert.equal(valid.transcriptAnchorId, undefined);
    for (const contentBlockIndex of [undefined, null, -1, 1.5, '0']) {
      const [unknown] = provider.normalizeMessage({ type, delta: { text: 'fixture' }, responseMessageId: '', contentBlockIndex }, SESSION_ID);
      assert.equal(unknown.responseMessageId, undefined);
      assert.equal(unknown.contentBlockIndex, undefined);
    }
  }
});

/**
 * Writes the transcript pair current Claude versions produce for one async
 * subagent: the parent session, and the agent's own transcript plus sidecar
 * metadata under `<session>/subagents/`.
 */
async function writeClaudeSubagentSession(projectDirectory: string): Promise<string> {
  const parentPath = path.join(projectDirectory, `${SESSION_ID}.jsonl`);
  const subagentDirectory = path.join(projectDirectory, SESSION_ID, 'subagents');
  await mkdir(subagentDirectory, { recursive: true });

  const parentLines = [
    {
      type: 'assistant',
      uuid: 'assistant-1',
      sessionId: SESSION_ID,
      timestamp: '2026-08-21T10:00:00.000Z',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: AGENT_TOOL_USE_ID,
          name: 'Agent',
          input: { subagent_type: 'Explore', description: 'Survey the repo', prompt: 'Look around' },
        }],
      },
    },
    {
      type: 'user',
      uuid: 'launch-ack-1',
      sessionId: SESSION_ID,
      timestamp: '2026-08-21T10:00:01.000Z',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: AGENT_TOOL_USE_ID,
          content: 'Async agent launched successfully. agentId: internal bookkeeping',
        }],
      },
      toolUseResult: {
        isAsync: true,
        status: 'async_launched',
        agentId: AGENT_ID,
        description: 'Survey the repo',
        resolvedModel: 'claude-opus-5',
      },
    },
    {
      type: 'user',
      uuid: 'notification-1',
      sessionId: SESSION_ID,
      timestamp: '2026-08-21T10:05:00.000Z',
      message: {
        role: 'user',
        content: [{
          type: 'text',
          text: [
            '<task-notification>',
            `<task-id>${AGENT_ID}</task-id>`,
            `<tool-use-id>${AGENT_TOOL_USE_ID}</tool-use-id>`,
            '<status>completed</status>',
            '<summary>Agent "Survey the repo" finished</summary>',
            '<result>The repo has two packages.</result>',
            '</task-notification>',
          ].join('\n'),
        }],
      },
    },
  ];
  await writeFile(parentPath, `${parentLines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');

  const agentLines = [
    {
      type: 'assistant',
      isSidechain: true,
      agentId: AGENT_ID,
      timestamp: '2026-08-21T10:00:30.000Z',
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        content: [
          { type: 'text', text: 'Starting the survey.' },
          { type: 'tool_use', id: 'toolu_child_1', name: 'Read', input: { file_path: '/repo/package.json' } },
        ],
      },
    },
    {
      type: 'user',
      isSidechain: true,
      agentId: AGENT_ID,
      timestamp: '2026-08-21T10:00:31.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_child_1', content: '{"name":"repo"}' }],
      },
    },
  ];
  await writeFile(
    path.join(subagentDirectory, `agent-${AGENT_ID}.jsonl`),
    `${agentLines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    'utf8',
  );
  await writeFile(
    path.join(subagentDirectory, `agent-${AGENT_ID}.meta.json`),
    JSON.stringify({ agentType: 'Explore', description: 'Survey the repo', toolUseId: AGENT_TOOL_USE_ID, spawnDepth: 1 }),
    'utf8',
  );

  return parentPath;
}

test('Claude history attaches a subagent transcript stored under the session directory', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-subagent-'));

  try {
    const parentPath = await writeClaudeSubagentSession(tempRoot);

    await withIsolatedDatabase(async () => {
      const now = new Date().toISOString();
      sessionsDb.createSession(SESSION_ID, 'claude', tempRoot, 'Subagent session', now, now, parentPath);

      const history = await new ClaudeSessionsProvider().fetchHistory(SESSION_ID, {
        providerSessionId: SESSION_ID,
      });
      const agentRow = history.messages.find(
        (message) => message.kind === 'tool_use' && message.toolId === AGENT_TOOL_USE_ID,
      );

      assert.ok(agentRow, 'the Agent call must be in the transcript');
      assert.equal(agentRow.subagent?.id, AGENT_ID);
      assert.equal(agentRow.subagent?.type, 'Explore');
      assert.equal(agentRow.subagent?.description, 'Survey the repo');
      assert.equal(agentRow.subagent?.status, 'completed');

      // The agent's own work — prose and tool calls — comes from its separate
      // transcript, which is the file the previous lookup never found.
      assert.equal(agentRow.subagentTools?.length, 2);
      assert.equal(agentRow.subagentTools?.[0].kind, 'text');
      assert.equal(agentRow.subagentTools?.[1].toolName, 'Read');
      assert.equal(agentRow.subagentTools?.[1].toolResult?.content, '{"name":"repo"}');
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Claude history folds an agent task notification into the call that spawned it', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-notification-'));

  try {
    const parentPath = await writeClaudeSubagentSession(tempRoot);

    await withIsolatedDatabase(async () => {
      const now = new Date().toISOString();
      sessionsDb.createSession(SESSION_ID, 'claude', tempRoot, 'Subagent session', now, now, parentPath);

      const history = await new ClaudeSessionsProvider().fetchHistory(SESSION_ID, {
        providerSessionId: SESSION_ID,
      });
      const agentRow = history.messages.find(
        (message) => message.kind === 'tool_use' && message.toolId === AGENT_TOOL_USE_ID,
      );

      // The launch acknowledgement is internal bookkeeping; the agent's answer
      // is what belongs on its card.
      assert.equal(agentRow?.toolResult?.content, 'The repo has two packages.');

      const strayNotification = history.messages.find(
        (message) => typeof message.content === 'string' && message.content.includes('<task-notification>'),
      );
      assert.equal(strayNotification, undefined, 'the folded notification must not also render on its own');
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

/** Strips the `<task-notification>` turn so the agent has no reported outcome. */
async function dropTaskNotification(parentPath: string): Promise<void> {
  const raw = await readFile(parentPath, 'utf8');
  await writeFile(
    parentPath,
    `${raw.split('\n').filter((line) => line && !line.includes('task-notification')).join('\n')}\n`,
    'utf8',
  );
}

test('Claude history reads a missing notification off the agent\'s own transcript', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-finished-agent-'));

  try {
    const parentPath = await writeClaudeSubagentSession(tempRoot);
    await dropTaskNotification(parentPath);

    await withIsolatedDatabase(async () => {
      const now = new Date().toISOString();
      sessionsDb.createSession(SESSION_ID, 'claude', tempRoot, 'Subagent session', now, now, parentPath);

      const history = await new ClaudeSessionsProvider().fetchHistory(SESSION_ID, {
        providerSessionId: SESSION_ID,
      });
      const agentRow = history.messages.find(
        (message) => message.kind === 'tool_use' && message.toolId === AGENT_TOOL_USE_ID,
      );

      // The notification can be compacted out of a long session. The agent's
      // transcript ends on a resolved tool call, so it finished — reporting it
      // as still running would leave a spinner on the card forever.
      assert.equal(agentRow?.subagent?.status, 'completed');
      assert.equal(agentRow?.toolResult?.content, '', 'the launch acknowledgement must never show as a result');
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Claude history keeps an agent running when its transcript stops mid tool call', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-running-agent-'));

  try {
    const parentPath = await writeClaudeSubagentSession(tempRoot);
    await dropTaskNotification(parentPath);

    // Drop the child tool result: the agent is mid-call, which is the only
    // in-file evidence that it is still working.
    const agentPath = path.join(tempRoot, SESSION_ID, 'subagents', `agent-${AGENT_ID}.jsonl`);
    const agentRaw = await readFile(agentPath, 'utf8');
    await writeFile(
      agentPath,
      `${agentRaw.split('\n').filter((line) => line && !line.includes('tool_result')).join('\n')}\n`,
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      const now = new Date().toISOString();
      sessionsDb.createSession(SESSION_ID, 'claude', tempRoot, 'Subagent session', now, now, parentPath);

      const history = await new ClaudeSessionsProvider().fetchHistory(SESSION_ID, {
        providerSessionId: SESSION_ID,
      });
      const agentRow = history.messages.find(
        (message) => message.kind === 'tool_use' && message.toolId === AGENT_TOOL_USE_ID,
      );

      assert.equal(agentRow?.subagent?.status, 'running');
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Claude history trims a subagent timeline down to a preview', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-big-agent-'));

  try {
    const parentPath = await writeClaudeSubagentSession(tempRoot);

    // One child command with a very large output, which is what makes an
    // agent-heavy session's history payload balloon.
    const hugeOutput = 'x'.repeat(50_000);
    const agentPath = path.join(tempRoot, SESSION_ID, 'subagents', `agent-${AGENT_ID}.jsonl`);
    const agentRaw = await readFile(agentPath, 'utf8');
    const enlarged = agentRaw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const entry = JSON.parse(line) as { message?: { content?: Array<{ type?: string; content?: string }> } };
        for (const part of entry.message?.content ?? []) {
          if (part.type === 'tool_result') {
            part.content = hugeOutput;
          }
        }
        return JSON.stringify(entry);
      })
      .join('\n');
    await writeFile(agentPath, `${enlarged}\n`, 'utf8');

    await withIsolatedDatabase(async () => {
      const now = new Date().toISOString();
      sessionsDb.createSession(SESSION_ID, 'claude', tempRoot, 'Subagent session', now, now, parentPath);

      const history = await new ClaudeSessionsProvider().fetchHistory(SESSION_ID, {
        providerSessionId: SESSION_ID,
      });
      const agentRow = history.messages.find(
        (message) => message.kind === 'tool_use' && message.toolId === AGENT_TOOL_USE_ID,
      );
      const childResult = String(agentRow?.subagentTools?.[1].toolResult?.content ?? '');

      assert.ok(childResult.length < 6000, `nested output must be trimmed, got ${childResult.length}`);
      assert.match(childResult, /more characters$/, 'the trim must say how much was omitted');
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

const EDIT_SESSION_ID = 'claude-edit-session';

/**
 * Writes a transcript where one prompt was edited: the replacement shares a
 * parent with the original, which is the shape Claude's resume-partway leaves
 * behind. Nothing is deleted from the file.
 */
async function writeEditedTranscript(projectDirectory: string): Promise<string> {
  const transcriptPath = path.join(projectDirectory, `${EDIT_SESSION_ID}.jsonl`);
  const rows = [
    {
      type: 'user', uuid: 'u1', parentUuid: null, sessionId: EDIT_SESSION_ID,
      timestamp: '2026-08-23T10:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'first prompt' }] },
    },
    {
      type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: EDIT_SESSION_ID,
      timestamp: '2026-08-23T10:00:01.000Z',
      message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'first answer' }] },
    },
    {
      type: 'user', uuid: 'u2', parentUuid: 'a1', sessionId: EDIT_SESSION_ID,
      timestamp: '2026-08-23T10:00:02.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'original second prompt' }] },
    },
    {
      type: 'assistant', uuid: 'a2', parentUuid: 'u2', sessionId: EDIT_SESSION_ID,
      timestamp: '2026-08-23T10:00:03.000Z',
      message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'answer to be replaced' }] },
    },
    // The edit: same parent as u2, written later.
    {
      type: 'user', uuid: 'u2b', parentUuid: 'a1', sessionId: EDIT_SESSION_ID,
      timestamp: '2026-08-23T10:00:04.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'edited second prompt' }] },
    },
    {
      type: 'assistant', uuid: 'a2b', parentUuid: 'u2b', sessionId: EDIT_SESSION_ID,
      timestamp: '2026-08-23T10:00:05.000Z',
      message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'answer to the edit' }] },
    },
  ];

  await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return transcriptPath;
}

test('an edited prompt replaces the one it superseded instead of stacking on it', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-edit-history-'));

  try {
    const transcriptPath = await writeEditedTranscript(tempRoot);

    await withIsolatedDatabase(async () => {
      const now = new Date().toISOString();
      sessionsDb.createSession(EDIT_SESSION_ID, 'claude', tempRoot, 'Edited session', now, now, transcriptPath);

      const history = await new ClaudeSessionsProvider().fetchHistory(EDIT_SESSION_ID, {
        providerSessionId: EDIT_SESSION_ID,
      });
      const texts = history.messages.map((message) => message.content);

      assert.deepEqual(texts, [
        'first prompt',
        'first answer',
        'edited second prompt',
        'answer to the edit',
      ]);
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('parallel tool calls are not mistaken for an edit', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-parallel-tools-'));
  const sessionId = 'claude-parallel-session';

  try {
    const transcriptPath = path.join(tempRoot, `${sessionId}.jsonl`);
    // One assistant turn issuing two tools: each tool_result parents onto the
    // same row, so this row has two children — a branch point that must not be
    // pruned, or tool output disappears from every transcript in the app.
    const rows = [
      {
        type: 'user', uuid: 'p1', parentUuid: null, sessionId,
        timestamp: '2026-08-23T10:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'do two things' }] },
      },
      {
        type: 'assistant', uuid: 'pa1', parentUuid: 'p1', sessionId,
        timestamp: '2026-08-23T10:00:01.000Z',
        message: {
          role: 'assistant', model: 'claude-opus-5',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/a' } }],
        },
      },
      {
        type: 'user', uuid: 'pr1', parentUuid: 'pa1', sessionId,
        timestamp: '2026-08-23T10:00:02.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'contents of a' }] },
      },
      {
        type: 'user', uuid: 'pr2', parentUuid: 'pa1', sessionId,
        timestamp: '2026-08-23T10:00:03.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'contents of b' }] },
      },
    ];
    await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

    await withIsolatedDatabase(async () => {
      const now = new Date().toISOString();
      sessionsDb.createSession(sessionId, 'claude', tempRoot, 'Parallel tools', now, now, transcriptPath);

      const history = await new ClaudeSessionsProvider().fetchHistory(sessionId, {
        providerSessionId: sessionId,
      });

      assert.equal(
        history.messages.some((message) => message.content === 'do two things'),
        true,
      );
      const toolRow = history.messages.find((message) => message.kind === 'tool_use');
      assert.ok(toolRow, 'the tool call survives');
      assert.equal(toolRow?.toolResult?.content, 'contents of a');
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('resolving an edit anchor returns the assistant turn before it', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-edit-anchor-'));

  try {
    const transcriptPath = await writeEditedTranscript(tempRoot);

    await withIsolatedDatabase(async () => {
      const now = new Date().toISOString();
      sessionsDb.createSession(EDIT_SESSION_ID, 'claude', tempRoot, 'Edited session', now, now, transcriptPath);
      const provider = new ClaudeSessionsProvider();

      // Resuming is inclusive of the row it names, so replacing `u2b` must
      // resume through `a1` — naming `u2b` itself would leave the prompt being
      // replaced in context.
      assert.deepEqual(
        await provider.resolveEditAnchor(EDIT_SESSION_ID, 'u2b'),
        { found: true, resumeThroughId: 'a1' },
      );

      // Nothing precedes the first prompt, so the conversation starts over.
      assert.deepEqual(
        await provider.resolveEditAnchor(EDIT_SESSION_ID, 'u1'),
        { found: true, resumeThroughId: null },
      );

      assert.deepEqual(
        await provider.resolveEditAnchor(EDIT_SESSION_ID, 'not-in-transcript'),
        { found: false, resumeThroughId: null },
      );
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('user turns carry the transcript uuid so they can be edited', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-anchor-ids-'));

  try {
    const transcriptPath = await writeEditedTranscript(tempRoot);

    await withIsolatedDatabase(async () => {
      const now = new Date().toISOString();
      sessionsDb.createSession(EDIT_SESSION_ID, 'claude', tempRoot, 'Edited session', now, now, transcriptPath);

      const history = await new ClaudeSessionsProvider().fetchHistory(EDIT_SESSION_ID, {
        providerSessionId: EDIT_SESSION_ID,
      });

      const userRows = history.messages.filter((message) => message.role === 'user');
      assert.deepEqual(
        userRows.map((message) => message.transcriptAnchorId),
        ['u1', 'u2b'],
      );
      // Assistant rows are never an anchor: the UI only offers editing on a
      // turn the user typed.
      assert.equal(
        history.messages.some((message) => message.role !== 'user' && message.transcriptAnchorId),
        false,
      );
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('resolving an edit anchor skips rows that are not conversation turns', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-anchor-skip-'));
  const sessionId = 'claude-anchor-skip-session';

  try {
    const transcriptPath = path.join(tempRoot, `${sessionId}.jsonl`);
    // An attachment row sits between the assistant turn and the next prompt.
    // Resuming names an assistant message, so the walk has to pass over it —
    // naming the attachment would resume at something the SDK cannot address.
    const rows = [
      {
        type: 'user', uuid: 'su1', parentUuid: null, sessionId,
        timestamp: '2026-08-23T10:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      },
      {
        type: 'assistant', uuid: 'sa1', parentUuid: 'su1', sessionId,
        timestamp: '2026-08-23T10:00:01.000Z',
        message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'hi' }] },
      },
      {
        type: 'attachment', uuid: 'sat1', parentUuid: 'sa1', sessionId,
        timestamp: '2026-08-23T10:00:02.000Z',
      },
      {
        type: 'user', uuid: 'su2', parentUuid: 'sat1', sessionId,
        timestamp: '2026-08-23T10:00:03.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'second prompt' }] },
      },
    ];
    await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

    await withIsolatedDatabase(async () => {
      const now = new Date().toISOString();
      sessionsDb.createSession(sessionId, 'claude', tempRoot, 'Anchor skip', now, now, transcriptPath);

      assert.deepEqual(
        await new ClaudeSessionsProvider().resolveEditAnchor(sessionId, 'su2'),
        { found: true, resumeThroughId: 'sa1' },
      );
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});


async function checkResumedBranch(extraRows: Record<string, unknown>[], verify: (history: Awaited<ReturnType<ClaudeSessionsProvider['fetchHistory']>>, provider: ClaudeSessionsProvider) => Promise<void> | void) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'claude-resumed-branch-'));
  try {
    const transcriptPath = await writeEditedTranscript(directory);
    const original = await readFile(transcriptPath, 'utf8');
    const rows = extraRows.map((row, index) => ({ sessionId: EDIT_SESSION_ID, timestamp: `2026-08-23T10:01:${String(index).padStart(2, '0')}.000Z`, ...row }));
    const fixture = original + rows.map(row => JSON.stringify(row)).join('\n') + '\n';
    await writeFile(transcriptPath, fixture);
    await withIsolatedDatabase(async () => {
      const now = new Date().toISOString();
      sessionsDb.createSession(EDIT_SESSION_ID, 'claude', directory, 'Resumed branch fixture', now, now, transcriptPath);
      const provider = new ClaudeSessionsProvider();
      await verify(await provider.fetchHistory(EDIT_SESSION_ID, { providerSessionId: EDIT_SESSION_ID }), provider);
    });
    assert.equal(await readFile(transcriptPath, 'utf8'), fixture, 'History projection must never edit the provider transcript.');
  } finally { await rm(directory, { recursive: true, force: true }); }
}
const prompt = (uuid: string, parentUuid: string, text: string, extra: Record<string, unknown> = {}) => ({ type: 'user', uuid, parentUuid, message: { role: 'user', content: [{ type: 'text', text }] }, ...extra });
const answer = (uuid: string, parentUuid: string, text: string) => ({ type: 'assistant', uuid, parentUuid, message: { role: 'assistant', content: [{ type: 'text', text }] } });

test('a real user continuation after rewind restores the older sibling ancestry and its new replies', { concurrency: false }, async () => {
  await checkResumedBranch([prompt('u3', 'a2', 'Continue original branch'), answer('a3', 'u3', 'New reply after resuming')], async (history, provider) => {
    assert.deepEqual(history.messages.map(message => message.content), ['first prompt', 'first answer', 'original second prompt', 'answer to be replaced', 'Continue original branch', 'New reply after resuming']);
    assert.deepEqual(await provider.resolveEditAnchor(EDIT_SESSION_ID, 'u3'), { found: true, resumeThroughId: 'a2' }, 'Future edits still use the real native ancestry.');
  });
});

test('late assistant, sidechain prompts, notifications and tool-result text do not reactivate the replaced branch', { concurrency: false }, async () => {
  await checkResumedBranch([
    answer('late-a', 'a2', 'Late obsolete output'),
    prompt('side-user', 'a2', 'Sidechain prompt', { isSidechain: true }),
    prompt('task-note', 'a2', '<task-notification>background</task-notification>'),
    { type: 'user', uuid: 'late-tool', parentUuid: 'a2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old-tool', content: 'Tool output' }, { type: 'text', text: 'Tool annotation' }] } },
  ], history => {
    assert.deepEqual(history.messages.map(message => message.content), ['first prompt', 'first answer', 'edited second prompt', 'answer to the edit']);
  });
});

test('a later edit of the restored continuation still hides only the replaced prompt branch', { concurrency: false }, async () => {
  await checkResumedBranch([
    prompt('u3', 'a2', 'Restored continuation'), answer('a3', 'u3', 'Restored reply'),
    prompt('u3-edit', 'a2', 'Edited continuation'), answer('a3-edit', 'u3-edit', 'Current edited reply'),
  ], history => {
    assert.deepEqual(history.messages.map(message => message.content), ['first prompt', 'first answer', 'original second prompt', 'answer to be replaced', 'Edited continuation', 'Current edited reply']);
  });
});

test('duplicate old UUID replays cannot select the obsolete branch or erase the currently selected prompt', { concurrency: false }, async () => {
  await checkResumedBranch([prompt('u2', 'a1', 'original second prompt')], history => {
    assert.deepEqual(history.messages.map(message => message.content), ['first prompt', 'first answer', 'edited second prompt', 'answer to the edit']);
  });
});

test('missing-parent and cyclic metadata leave the newest independent prompt visible without looping', { concurrency: false }, async () => {
  await checkResumedBranch([
    prompt('new-independent', 'missing-parent', 'New independent prompt'), answer('new-independent-answer', 'new-independent', 'Independent reply'),
    { type: 'system', uuid: 'cycle-one', parentUuid: 'cycle-two' }, { type: 'system', uuid: 'cycle-two', parentUuid: 'cycle-one' },
  ], history => {
    assert.ok(history.messages.some(message => message.content === 'New independent prompt'));
    assert.ok(history.messages.some(message => message.content === 'Independent reply'));
    assert.ok(history.messages.some(message => message.content === 'edited second prompt'));
  });
});

test('native user identity follows an exact consumed API response through tool-result ancestry, never repeated text', { concurrency: false }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'claude-input-identity-'));
  const nativeSessionId = 'identity-session-fixture';
  const row = (uuid: string, parentUuid: string | null, type: string, content: unknown, extra = {}) => ({
    type, uuid, parentUuid, sessionId: nativeSessionId, timestamp: new Date(1_700_000_000_000).toISOString(),
    message: { role: type, content }, ...extra,
  });
  const rows = [
    row('user-old', null, 'user', 'same words'),
    row('answer-old', 'user-old', 'assistant', [{ type: 'text', text: 'old reply' }], { message: { role: 'assistant', id: 'api-old', content: [{ type: 'text', text: 'old reply' }] } }),
    row('native-rewritten-user', 'answer-old', 'user', 'same words'),
    row('tool-call', 'native-rewritten-user', 'assistant', [{ type: 'tool_use', id: 'tool-fixture', name: 'Read', input: {} }]),
    row('tool-result', 'tool-call', 'user', [{ type: 'tool_result', tool_use_id: 'tool-fixture', content: 'fixture output' }]),
    row('answer-current', 'tool-result', 'assistant', '', { message: { role: 'assistant', id: 'api-consumption-receipt', content: [{ type: 'text', text: 'current reply' }] } }),
    row('child-answer', 'native-rewritten-user', 'assistant', '', { parent_tool_use_id: 'agent-tool', message: { role: 'assistant', id: 'api-child', content: [{ type: 'text', text: 'child reply' }] } }),
    row('orphan-answer', 'missing-parent', 'assistant', '', { message: { role: 'assistant', id: 'api-orphan', content: [{ type: 'text', text: 'orphan reply' }] } }),
  ];
  const transcriptPath = path.join(directory, `${nativeSessionId}.jsonl`);
  const original = rows.map(row => JSON.stringify(row)).join('\n');
  await writeFile(transcriptPath, original);
  try {
    await withIsolatedDatabase(async () => {
      sessionsDb.createSession(nativeSessionId, 'claude', directory, 'Synthetic identity fixture', undefined, undefined, transcriptPath);
      const history = await new ClaudeSessionsProvider().fetchHistory(nativeSessionId);
      const users = history.messages.filter(message => message.role === 'user' && message.kind === 'text');
      assert.equal(users.length, 2);
      assert.deepEqual(users.find(message => message.transcriptAnchorId === 'user-old')?.responseMessageIds, ['api-old']);
      assert.deepEqual(users.find(message => message.transcriptAnchorId === 'native-rewritten-user')?.responseMessageIds, ['api-consumption-receipt']);
      assert.equal(await readFile(transcriptPath, 'utf8'), original, 'Identity annotation never rewrites provider transcript data.');
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('queued user creation times cannot reorder saved turns or their history pages', { concurrency: false }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'claude-queued-history-'));
  const nativeSessionId = 'queued-native-fixture';
  const appSessionId = 'queued-app-fixture';
  // This is append order and a single explicit parent chain. The second user
  // message was created while the first response was still being generated.
  const rows = [
    { uuid: 'first-user', parentUuid: null, type: 'user', timestamp: '2026-08-23T10:00:00.000Z', message: { role: 'user', content: 'First question' } },
    { uuid: 'first-answer', parentUuid: 'first-user', type: 'assistant', timestamp: '2026-08-23T10:03:00.000Z', message: { role: 'assistant', id: 'first-api-answer', content: 'First answer finishes' } },
    { uuid: 'queued-user', parentUuid: 'first-answer', type: 'user', timestamp: '2026-08-23T10:01:00.000Z', message: { role: 'user', content: 'Queued follow-up' } },
    { uuid: 'queued-answer', parentUuid: 'queued-user', type: 'assistant', timestamp: '2026-08-23T10:04:00.000Z', message: { role: 'assistant', id: 'queued-api-answer', content: 'Answer to queued follow-up' } },
  ].map(row => ({ ...row, sessionId: nativeSessionId }));
  const transcriptPath = path.join(directory, `${nativeSessionId}.jsonl`);
  const original = rows.map(row => JSON.stringify(row)).join('\n');
  await writeFile(transcriptPath, original);
  try {
    await withIsolatedDatabase(async () => {
      sessionsDb.createSession(appSessionId, 'claude', directory, 'Queued history fixture', undefined, undefined, transcriptPath);
      const provider = new ClaudeSessionsProvider();
      const options = { providerSessionId: nativeSessionId };
      const history = await provider.fetchHistory(appSessionId, options);
      assert.deepEqual(history.messages.map(message => message.content), rows.map(row => row.message.content));
      const latest = await provider.fetchHistory(appSessionId, { ...options, limit: 2 });
      const earlier = await provider.fetchHistory(appSessionId, { ...options, limit: 2, offset: 2 });
      assert.deepEqual([...earlier.messages, ...latest.messages].map(message => message.id), history.messages.map(message => message.id));
      assert.deepEqual(latest.messages.map(message => message.content), ['Queued follow-up', 'Answer to queued follow-up']);
      assert.equal(latest.total, 4);
      assert.equal(latest.hasMore, true);
      assert.equal(earlier.hasMore, false);
      assert.equal(latest.messages[0].timestamp, rows[2].timestamp, 'Creation time remains accurate even when consumption is later.');
      assert.equal(latest.messages[0].transcriptAnchorId, 'queued-user');
      assert.deepEqual(latest.messages[0].responseMessageIds, ['queued-api-answer']);
      assert.deepEqual((await provider.fetchHistory(appSessionId, options)).messages.map(message => message.id), history.messages.map(message => message.id));
      assert.equal(await readFile(transcriptPath, 'utf8'), original, 'Reading history never rewrites the native transcript.');
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
