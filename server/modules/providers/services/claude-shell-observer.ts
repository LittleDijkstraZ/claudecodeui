import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { claudeExecutionRecords } from '@/modules/providers/services/claude-execution-records.js';
import type { ClaudeExecutionRecord } from '@/shared/types.js';

/** Used by the native Shell hook and fixture tests to retain only explicit main-thread observations. */
export function shellConfigurationObservation(input: Record<string, unknown>): ClaudeExecutionRecord['observed'] | null {
  if (input.agent_id || input.parent_tool_use_id) return null;
  const observation: ClaudeExecutionRecord['observed'] = { source: 'shell-hook' };
  const model = input.hook_event_name === 'PostModelSwitch' ? input.to_model : input.model;
  if (typeof model === 'string' && model && model !== '<synthetic>') observation.model = model;
  if (typeof input.permission_mode === 'string') observation.permissionMode = input.permission_mode;
  const effort = input.effort as { level?: unknown } | undefined;
  if (effort && typeof effort.level === 'string') observation.effort = effort.level;
  if (typeof input.prompt_id === 'string') observation.promptId = input.prompt_id;
  // xhigh never proves Ultracode; native hooks do not currently report that flag.
  return observation.model || observation.effort || observation.permissionMode ? observation : null;
}

// This entry is launched only by an explicitly opened remote Claude terminal.
// Importing its pure observer in tests never starts Claude or reads a personal DB.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => { if (raw.length < 1024 * 1024) raw += chunk; });
  process.stdin.on('end', () => {
    const previousLog = console.log;
    console.log = () => {};
    try {
      if (raw.length > 1024 * 1024) return;
      const input = JSON.parse(raw) as Record<string, unknown>;
      const executionId = process.argv[2];
      const databasePath = process.argv[3];
      if (!executionId || !databasePath || !path.isAbsolute(databasePath)) return;
      // Pin the parent server database even when Claude project settings change its child environment.
      process.env.DATABASE_PATH = databasePath;
      const record = claudeExecutionRecords.get(executionId);
      if (!record || record.surface !== 'shell' || record.providerSessionId !== input.session_id || record.projectPath !== input.cwd) return;
      const observation = shellConfigurationObservation(input);
      if (observation) claudeExecutionRecords.observe(executionId, observation);
    } catch { /* Unsupported/disabled hooks leave effective settings unconfirmed. */ }
    finally { console.log = previousLog; }
  });
}
