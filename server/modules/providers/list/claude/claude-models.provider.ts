import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';


import { sessionsDb } from '@/modules/database/index.js';
import type {
  IProviderModels,
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/index.js';

import { createClaudeModelCatalog } from './claude-model-catalog.js';

/** Used by the Claude model catalog and runtime to validate model-specific choices. */
export const CLAUDE_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'default',
      label: 'Default (recommended)',
      description: 'Let the remote Claude CLI resolve its environment, settings, and session defaults.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'best',
      label: 'Best available',
      description: 'Use Fable 5 when available, otherwise the latest Opus model.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          {
            value: 'ultracode',
            description: 'xhigh reasoning with automatic workflows; uses more API tokens.',
          },
        ],
      },
    },
    {
      value: 'fable',
      label: 'Fable 5',
      description: 'Most capable Claude model for the hardest, longest-running tasks.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          {
            value: 'ultracode',
            description: 'xhigh reasoning with automatic workflows; uses more API tokens.',
          },
        ],
      },
    },
    {
      value: 'sonnet',
      label: 'Sonnet',
      description: 'Latest Sonnet model for everyday coding tasks.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          {
            value: 'ultracode',
            description: 'xhigh reasoning with automatic workflows; uses more API tokens.',
          },
        ],
      },
    },
    {
      value: 'sonnet[1m]',
      label: 'Sonnet (1M context)',
      description: 'Latest Sonnet model with a 1M context window.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          {
            value: 'ultracode',
            description: 'xhigh reasoning with automatic workflows; uses more API tokens.',
          },
        ],
      },
    },
    {
      value: 'opus',
      label: 'Opus',
      description: 'Latest Opus model for complex reasoning and coding tasks.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          {
            value: 'ultracode',
            description: 'xhigh reasoning with automatic workflows; uses more API tokens.',
          },
        ],
      },
    },
    {
      value: 'opus[1m]',
      label: 'Opus (1M context)',
      description: 'Latest Opus model with a 1M context window.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          {
            value: 'ultracode',
            description: 'xhigh reasoning with automatic workflows; uses more API tokens.',
          },
        ],
      },
    },
    {
      value: 'haiku',
      label: 'Haiku',
      description: 'Fast and efficient Claude model for simple tasks.',
    },
    {
      value: 'opusplan',
      label: 'Opus Plan',
      description: 'Use Opus while planning, then switch to Sonnet for execution.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          {
            value: 'ultracode',
            description: 'xhigh reasoning with automatic workflows; uses more API tokens.',
          },
        ],
      },
    },
  ],
  DEFAULT: 'default',
};

/** Used by provider model consumers to resolve entries in the Claude catalog. */
export const findClaudeModelOption = (model: string | undefined | null): ProviderModelOption | null => {
  const normalizedModel = typeof model === 'string' ? model.trim() : '';
  if (!normalizedModel) {
    return null;
  }

  return CLAUDE_PREDEFINED_MODELS.OPTIONS.find((option) => option.value === normalizedModel) ?? null;
};
/** Provider model lookup and tests read only actual main-thread model reports. */
export async function readClaudeReportedModel(sessionId: string, jsonlPath: string): Promise<ProviderCurrentActiveModel | null> {
  let response: ProviderCurrentActiveModel | null = null;
  let initialization: ProviderCurrentActiveModel | null = null;
  const stream = createReadStream(jsonlPath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      try {
        const event = JSON.parse(line);
        const eventSessionId = event.sessionId ?? event.session_id;
        if ((eventSessionId && eventSessionId !== sessionId) || event.isSidechain || event.parent_tool_use_id) continue;
        const reportedAt = typeof event.timestamp === 'string' ? event.timestamp : null;
        if (event.type === 'assistant' && typeof event.message?.model === 'string') {
          const model = event.message.model.trim();
          if (model && model !== '<synthetic>' && model !== 'synthetic') response = { model, reportedModel: model, reportedSource: 'response', reportedAt };
        } else if (event.type === 'system' && event.subtype === 'init' && typeof event.model === 'string' && event.model.trim()) {
          const model = event.model.trim();
          initialization = { model, reportedModel: model, reportedSource: 'initialization', reportedAt };
        }
      } catch { /* Ignore an incomplete trailing record while the CLI writes. */ }
    }
  } finally { lines.close(); stream.destroy(); }
  return response ?? initialization;
}

const loadCatalog = createClaudeModelCatalog();

/** Supplies model choices and current-session metadata to the Claude provider. */
export class ClaudeProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    return loadCatalog(CLAUDE_PREDEFINED_MODELS);
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (!sessionId?.trim()) {
      return { model: 'default', reportedModel: null, reportedSource: 'unknown', reportedAt: null };
    }

    try {
      const session = sessionsDb.getSessionById(sessionId);
      const jsonlPath = session?.jsonl_path;
      const activeModel = jsonlPath
        ? await readClaudeReportedModel(session?.provider_session_id || sessionId, jsonlPath)
        : null;
      if (activeModel?.model) {
        return activeModel;
      }
    } catch {
      // Fall through to the provider default when the session-backed lookup fails.
    }

    return { model: 'default', reportedModel: null, reportedSource: 'unknown', reportedAt: null };
  }
}
