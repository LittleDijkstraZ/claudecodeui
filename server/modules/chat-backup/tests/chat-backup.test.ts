import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import type { ChatBackupBundle } from '@/shared/index.js';

import { createChatBackupService } from '../chat-backup.service.js';
import { restoreNativeChatBackup } from '../chat-backup-native.service.js';
import { validateChatBackupBundle } from '../chat-backup-validation.js';

const SOURCE = '10000000-0000-4000-8000-000000000001';
const USER = '10000000-0000-4000-8000-000000000002';
const ASSISTANT = '10000000-0000-4000-8000-000000000003';

function claudeBundle(projectPath = '/original/project'): ChatBackupBundle {
  const rows = [
    { type: 'user', uuid: USER, parentUuid: null, sessionId: SOURCE, cwd: projectPath, timestamp: '2026-09-09T00:00:00.000Z', message: { role: 'user', content: 'Remember the blue square.' } },
    { type: 'assistant', uuid: ASSISTANT, parentUuid: USER, sessionId: SOURCE, cwd: projectPath, timestamp: '2026-09-09T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'The square is blue.' }] } },
  ];
  return { format: 'cloudcli-chat-backup', version: 1, createdAt: '2026-09-09T00:00:02.000Z',
    session: { id: 'app-source', provider: 'claude', title: 'Saved square', projectPath, providerSessionId: SOURCE, model: 'claude-sonnet-4', effort: 'high' },
    files: [{ path: 'main.jsonl', content: rows.map(row => JSON.stringify(row)).join('\n') + '\n' }],
  };
}

function codexBundle(projectPath: string): ChatBackupBundle {
  const turnId = randomUUID();
  const timestamp = '2026-09-09T00:00:00.000Z';
  const rows = [
    { type: 'session_meta', payload: { id: SOURCE, timestamp, cwd: projectPath, originator: 'codex_cli_rs', cli_version: '0.146.0', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId, model_context_window: 200000 } },
    { type: 'turn_context', payload: { turn_id: turnId, cwd: projectPath, approval_policy: 'never', sandbox_policy: { type: 'read-only' }, model: 'gpt-5', effort: 'medium', summary: 'auto' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Remember the blue square.' }] } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Remember the blue square.', images: [] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The square is blue.' }] } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'The square is blue.' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } },
  ].map(row => ({ timestamp, ...row }));
  const bundle = claudeBundle(projectPath);
  bundle.session.provider = 'codex';
  bundle.session.model = 'gpt-5';
  bundle.files = [{ path: 'main.jsonl', content: rows.map(row => JSON.stringify(row)).join('\n') + '\n' }];
  return bundle;
}

async function fixture(run: (context: { root: string; project: string; home: string }) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chat-backup-test-')));
  const project = path.join(root, 'destination');
  const home = path.join(root, 'provider');
  await fs.mkdir(project);
  await fs.mkdir(home);
  const previous = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'app.db');
  await fs.writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();
  projectsDb.createProjectPath(project);
  try { await run({ root, project, home }); }
  finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('validates native context and rejects paths, mismatched identity, duplicates and render-only history', () => {
  assert.equal(validateChatBackupBundle(claudeBundle()).session.title, 'Saved square');
  for (const filePath of ['../main.jsonl', '/tmp/main.jsonl', 'subagents/../../settings.json', 'subagents\\agent.jsonl', 'settings.json']) {
    const bundle = claudeBundle(); bundle.files.push({ path: filePath, content: '{}' });
    assert.throws(() => validateChatBackupBundle(bundle), { code: 'BACKUP_INVALID' });
  }
  const duplicate = claudeBundle(); duplicate.files.push(duplicate.files[0]);
  assert.throws(() => validateChatBackupBundle(duplicate), { code: 'BACKUP_INVALID' });
  const wrong = claudeBundle(); wrong.session.providerSessionId = randomUUID();
  assert.throws(() => validateChatBackupBundle(wrong), { code: 'BACKUP_INVALID' });
  const corrupt = claudeBundle(); corrupt.files[0].content += '{broken';
  assert.throws(() => validateChatBackupBundle(corrupt), { code: 'BACKUP_INVALID' });
  const displayOnly = codexBundle('/tmp');
  displayOnly.files[0].content = displayOnly.files[0].content.split('\n').filter(line => !line.includes('response_item')).join('\n');
  assert.throws(() => validateChatBackupBundle(displayOnly), { code: 'BACKUP_EMPTY' });
});

test('exports indexed native context and only portable session-owned sidecars', { concurrency: false }, async () => fixture(async ({ project, home }) => {
  const bundle = claudeBundle(project);
  const main = path.join(home, `${SOURCE}.jsonl`);
  await fs.writeFile(main, bundle.files[0].content);
  await fs.mkdir(path.join(home, SOURCE, 'subagents'), { recursive: true });
  await fs.writeFile(path.join(home, SOURCE, 'subagents', 'agent-a.meta.json'), '{"agentType":"helper"}');
  await fs.writeFile(path.join(home, 'settings.json'), '{"secret":"must not export"}');
  sessionsDb.createSession(SOURCE, 'claude', project, 'Source title', undefined, undefined, main);
  const service = createChatBackupService({ providerHome: () => home, broadcast: async () => {} });
  const result = await service.exportSession(SOURCE);
  assert.deepEqual(result.files.map(file => file.path), ['main.jsonl', 'subagents/agent-a.meta.json']);
  assert.equal(result.files[0].content, bundle.files[0].content);
  assert.equal(JSON.stringify(result).includes('must not export'), false);
  await fs.symlink(path.join(home, 'settings.json'), path.join(home, SOURCE, 'subagents', 'agent-secret.meta.json'));
  await assert.rejects(service.exportSession(SOURCE), { code: 'BACKUP_INVALID' });
}));

test('refuses unsupported sessions and empty drafts', { concurrency: false }, async () => fixture(async ({ project, home }) => {
  const service = createChatBackupService({ providerHome: () => home });
  sessionsDb.createAppSession('empty', 'claude', project);
  sessionsDb.createAppSession('cursor', 'cursor', project);
  await assert.rejects(service.exportSession('empty'), { code: 'BACKUP_EMPTY' });
  await assert.rejects(service.exportSession('cursor'), { code: 'BACKUP_UNSUPPORTED_PROVIDER' });
  await assert.rejects(service.exportSession('missing'), { code: 'SESSION_NOT_FOUND' });
}));

test('oversized transcript is refused before reading and missing provider storage has a clear error', { concurrency: false }, async () => fixture(async ({ project, home }) => {
  const filename = path.join(home, `${SOURCE}.jsonl`);
  const file = await fs.open(filename, 'w');
  await file.truncate(64 * 1024 * 1024 + 1);
  await file.close();
  sessionsDb.createSession(SOURCE, 'claude', project, 'Large', undefined, undefined, filename);
  const service = createChatBackupService({ providerHome: () => home });
  await assert.rejects(service.exportSession(SOURCE), { code: 'BACKUP_TOO_LARGE' });
  await fs.rm(home, { recursive: true });
  await assert.rejects(service.exportSession(SOURCE), { code: 'BACKUP_UNAVAILABLE' });
}));

test('Claude restore uses SDK UUID remapping and retains a readable native conversation in the destination project', { concurrency: false }, async () => fixture(async ({ project, home }) => {
  const bundle = claudeBundle();
  bundle.files[0].content += JSON.stringify({ type: 'relocated', sessionId: SOURCE, relocatedCwd: '/old/relocated' }) + '\n';
  bundle.files.push({ path: 'subagents/agent-example.jsonl', content: bundle.files[0].content });
  const toolJsonl = '{"value":1}\n17\n"done"\n';
  bundle.files.push({ path: 'tool-results/query.jsonl', content: toolJsonl });
  const broadcasts: string[] = [];
  const service = createChatBackupService({ providerHome: () => home, broadcast: async id => { broadcasts.push(id); } });
  const restored = await service.restore(bundle, project);
  const row = sessionsDb.getSessionById(restored.sessionId)!;
  assert.notEqual(row.provider_session_id, SOURCE);
  assert.equal(row.project_path, project);
  assert.equal(row.model, bundle.session.model);
  assert.equal(row.effort, bundle.session.effort);
  assert.equal(row.custom_name, bundle.session.title);
  assert.ok(projectsDb.getProjectPath(project));
  assert.deepEqual(broadcasts, [restored.sessionId]);
  const records = (await fs.readFile(row.jsonl_path!, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const user = records.find(record => record.type === 'user');
  const assistant = records.find(record => record.type === 'assistant');
  assert.notEqual(user.uuid, USER);
  assert.equal(assistant.parentUuid, user.uuid);
  assert.equal(user.sessionId, row.provider_session_id);
  assert.equal(user.cwd, project);
  assert.equal(records.find(record => record.type === 'relocated').relocatedCwd, project);
  const messages = await getSessionMessages(row.provider_session_id!, { dir: project, sessionStore: { load: async () => records, append: async () => {} } });
  assert.equal(messages.length, 2);
  const history = await sessionsService.fetchHistory(restored.sessionId);
  assert.ok(history.messages.some(message => message.content?.includes('blue square')));
  const sidecar = await fs.readFile(path.join(path.dirname(row.jsonl_path!), row.provider_session_id!, 'subagents', 'agent-example.jsonl'), 'utf8');
  assert.equal(sidecar.includes(row.provider_session_id!), true);
  assert.equal(sidecar.includes(SOURCE), false);
  assert.equal(await fs.readFile(path.join(path.dirname(row.jsonl_path!), row.provider_session_id!, 'tool-results', 'query.jsonl'), 'utf8'), toolJsonl);
  assert.equal(bundle.files[0].content.includes(SOURCE), true);
}));

test('indexing failure cleans only its new native artifact, and restore preserves existing project identity', { concurrency: false }, async () => fixture(async ({ project, home }) => {
  const projectId = projectsDb.getProjectPath(project)!.project_id;
  const nativeId = randomUUID();
  let cleaned = false;
  const deleted: string[] = [];
  const service = createChatBackupService({ providerHome: () => home,
    restoreNative: async () => ({ providerSessionId: nativeId, jsonlPath: path.join(home, 'new.jsonl'), cleanup: async () => { cleaned = true; } }),
    sessions: { getSessionById: sessionsDb.getSessionById, createForkedSession: () => { throw new Error('database unavailable'); }, deleteSessionById: id => { deleted.push(id); return true; } },
    broadcast: async () => {},
  });
  await assert.rejects(service.restore(claudeBundle(), project), /database unavailable/);
  assert.equal(cleaned, true);
  assert.deepEqual(deleted, [nativeId]);
  assert.equal(projectsDb.getProjectPath(project)!.project_id, projectId);
}));

test('invalid destination and invalid bundle cannot run provider restoration', { concurrency: false }, async () => fixture(async ({ root, home }) => {
  let calls = 0;
  const service = createChatBackupService({ providerHome: () => home, restoreNative: async () => { calls++; throw new Error('must not execute'); } });
  await assert.rejects(service.restore(claudeBundle(), path.join(root, 'missing')), { code: 'BACKUP_DESTINATION_INVALID' });
  await assert.rejects(service.restore({ ...claudeBundle(), version: 99 }, root), { code: 'BACKUP_INVALID' });
  assert.equal(calls, 0);
}));

test('Codex restore forks native response items without a model run and yields readable destination history', { concurrency: false }, async () => fixture(async ({ project, home }) => {
  const bundle = codexBundle('/original/project');
  const environmentHome = process.env.CODEX_HOME;
  const native = await restoreNativeChatBackup(validateChatBackupBundle(bundle), project, home);
  assert.equal(process.env.CODEX_HOME, environmentHome);
  assert.notEqual(native.providerSessionId, SOURCE);
  const content = await fs.readFile(native.jsonlPath, 'utf8');
  const rows = content.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.find(row => row.type === 'session_meta').payload.cwd, project);
  assert.ok(rows.some(row => row.type === 'response_item' && row.payload.role === 'user'));
  sessionsDb.createForkedSession({ sessionId: 'restored-codex', provider: 'codex', projectPath: project, customName: 'Restored',
    providerSessionId: native.providerSessionId, jsonlPath: native.jsonlPath, forkedFromSessionId: bundle.session.id, model: bundle.session.model, effort: bundle.session.effort });
  const history = await sessionsService.fetchHistory('restored-codex');
  assert.ok(history.messages.some(message => message.content?.includes('blue square')));
  await native.cleanup();
  await assert.rejects(fs.stat(native.jsonlPath), { code: 'ENOENT' });
}));
