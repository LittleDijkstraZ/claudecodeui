import { createHash } from 'node:crypto';

import type { ClaudeExecutionSettings, ProviderModelsDefinition } from '@/shared/types.js';
import { AppError } from '@/shared/index.js';

/** Used by Chat/Shell launch and configuration routes to normalize the same persisted selection. */
export function resolveClaudeExecutionSettings(
  selection: { model?: string | null; effort?: string | null },
  catalog?: ProviderModelsDefinition,
): ClaudeExecutionSettings {
  const model = selection.model?.trim() || 'default';
  const savedEffort = selection.effort?.trim() || 'default';
  const ultracode = savedEffort === 'ultracode';
  const effort = ultracode ? 'xhigh' : savedEffort;
  if (!/^[a-zA-Z0-9_./:[\]-]+$/.test(model) || !['default', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
    throw new AppError('Invalid Claude model or reasoning effort.', { code: 'INVALID_EXECUTION_SETTINGS', statusCode: 400 });
  }
  const option = catalog?.OPTIONS.find((entry) => entry.value === model);
  const baseOption = model.endsWith('[1m]') ? catalog?.OPTIONS.find(entry => entry.value === model.slice(0, -4)) : undefined;
  const reportedEffort = option?.effort ?? baseOption?.effort;
  // SDK metadata is learned from existing queries and is absent after a restart.
  // A missing exact ID (including a previously selected [1m] variant) or missing
  // capabilities is unknown, not a remote denial. Preserve explicit selections
  // for native Claude validation; only an actual effort list can reject them.
  // An empty list represents a remote's explicit "no effort support" report.
  if (savedEffort !== 'default' && reportedEffort && !reportedEffort.values.some((entry) => entry.value === savedEffort)) {
    throw new AppError(`This remote has not reported support for ${savedEffort} on ${model}. Choose a supported effort or Remote default.`, { code: 'UNSUPPORTED_EXECUTION_SETTINGS', statusCode: 409 });
  }
  return {
    model, effort, ultracode,
    revision: createHash('sha256').update(JSON.stringify([model, effort, ultracode])).digest('hex').slice(0, 16),
  };
}

/** Used by both SDK Chat options and agent Shell argv; these are requests, never proof of effective settings. */
export function claudeSettingsFlags(settings: ClaudeExecutionSettings): { effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; settings?: { ultracode: boolean; enableWorkflows?: boolean } } {
  return {
    ...(settings.effort !== 'default' ? { effort: settings.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' } : {}),
    settings: settings.ultracode ? { ultracode: true, enableWorkflows: true } : { ultracode: false },
  };
}
