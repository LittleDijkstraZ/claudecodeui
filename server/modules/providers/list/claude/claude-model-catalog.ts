import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk';

import type { ProviderModelOption, ProviderModelsDefinition } from '@/shared/index.js';

const aliases = new Set(['default', 'best', 'fable', 'sonnet', 'opus', 'haiku', 'opusplan']);
const string = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const modelBase = (value: string): string => value.replace(/\[1m\]$/i, '');
let sdkModels: ModelInfo[] = [];

/** The normal Claude runtime supplies its existing query's catalog; never opens a query. */
export function rememberClaudeSupportedModels(models: ModelInfo[]): void {
  sdkModels = models.filter((model) => string(model.value));
}

/** Models provider and tests use injected IO so catalog reads never invoke Claude or send prompts. */
export function createClaudeModelCatalog(dependencies: {
  readSettings?: () => Promise<Record<string, unknown>>;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
} = {}) {
  const env = dependencies.env ?? process.env;
  const request = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  const readSettings = dependencies.readSettings ?? (async () => {
    try {
      const directory = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
      return record(JSON.parse(await readFile(path.join(directory, 'settings.json'), 'utf8')));
    } catch { return {}; }
  });
  let cached: { key: string; until: number; rows: ProviderModelOption[] } | null = null;
  let pending: { key: string; promise: Promise<ProviderModelOption[]> } | null = null;

  const apiRows = async (settingsEnv: Record<string, unknown>): Promise<ProviderModelOption[]> => {
    const settings = { ...settingsEnv, ...env };
    // Non-Anthropic providers have their own catalogs; never send their credentials elsewhere.
    if (['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].some((key) => settings[key] === '1')) return [];
    const token = string(settings.ANTHROPIC_AUTH_TOKEN);
    const key = string(settings.ANTHROPIC_API_KEY);
    if (!token && !key) return [];
    const base = string(settings.ANTHROPIC_BASE_URL) || 'https://api.anthropic.com';
    const fingerprint = createHash('sha256').update(JSON.stringify([base, key, token])).digest('hex');
    if (cached?.key === fingerprint && cached.until > now()) return cached.rows;
    if (pending?.key === fingerprint) return pending.promise;
    const promise = (async () => {
      const rows: ProviderModelOption[] = [];
      try {
        const url = new URL(`${base.replace(/\/$/, '').replace(/\/v1$/, '')}/v1/models`);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return [];
        url.searchParams.set('limit', '100');
        const signal = AbortSignal.timeout(6000);
        for (let page = 0; page < 5; page += 1) {
          const response = await request(url, {
            method: 'GET', redirect: 'error', signal,
            headers: { 'anthropic-version': '2023-06-01', ...(token ? { authorization: `Bearer ${token}` } : { 'x-api-key': key }) },
          });
          if (!response.ok) throw new Error('Model catalog unavailable');
          const payload = record(await response.json());
          for (const item of Array.isArray(payload.data) ? payload.data : []) {
            const model = record(item);
            const id = string(model.id);
            if (!id || /\s/.test(id)) continue;
            const effort = record(record(model.capabilities).effort);
            const levels = ['low', 'medium', 'high', 'xhigh', 'max'].filter((level) => record(effort[level]).supported === true);
            rows.push({
              value: id, label: id, description: string(model.display_name), selectionKind: 'version', catalogSource: 'remote-api', contextMode: 'default',
              ...(typeof model.max_input_tokens === 'number' && model.max_input_tokens > 0 ? { maxInputTokens: model.max_input_tokens } : {}),
              ...(levels.length ? { effort: { values: [...levels.map((value) => ({ value })), ...(levels.includes('xhigh') ? [{ value: 'ultracode', description: 'xhigh reasoning with automatic workflows; uses more API tokens.' }] : [])] } } : {}),
            });
          }
          const after = string(payload.last_id);
          if (!payload.has_more || !after || after === url.searchParams.get('after_id')) break;
          url.searchParams.set('after_id', after);
        }
      } catch {
        // No credentials, response bodies, URLs, or raw SDK errors cross the API boundary.
      }
      cached = { key: fingerprint, until: now() + (rows.length ? 300_000 : 30_000), rows };
      return rows;
    })();
    pending = { key: fingerprint, promise };
    try { return await promise; } finally { if (pending?.promise === promise) pending = null; }
  };

  return async (predefined: ProviderModelsDefinition): Promise<ProviderModelsDefinition> => {
    const settings = await readSettings();
    const settingsEnv = record(settings.env);
    const effectiveEnv = { ...settingsEnv, ...env };
    const rows = new Map<string, ProviderModelOption>();
    const add = (option: ProviderModelOption) => rows.set(option.value, option);
    for (const original of predefined.OPTIONS) {
      const base = modelBase(original.value);
      const override = string(effectiveEnv[`ANTHROPIC_DEFAULT_${base.toUpperCase()}_MODEL`]);
      add({ ...original, label: base === 'default' ? 'Follow remote configuration' : base === 'opusplan' ? 'Opus Plan' : base[0].toUpperCase() + base.slice(1), selectionKind: 'alias', catalogSource: 'built-in', contextMode: original.value.endsWith('[1m]') ? '1m' : 'default', ...(override ? { resolvedModel: override } : {}) });
    }
    for (const option of await apiRows(settingsEnv)) add(option);
    for (const item of sdkModels) {
      const existing = rows.get(item.value);
      const base = modelBase(item.value);
      const levels = item.supportedEffortLevels ?? [];
      const effort = item.supportsEffort === false ? undefined : levels.length ? { values: [...levels.map((value) => ({ value: value as string })), ...(levels.includes('xhigh') ? [{ value: 'ultracode', description: 'xhigh reasoning with automatic workflows; uses more API tokens.' }] : [])] } : existing?.effort;
      const option: ProviderModelOption = { ...existing, value: item.value, label: aliases.has(base) ? existing?.label ?? base : base, description: item.description, selectionKind: aliases.has(base) ? 'alias' : 'version', catalogSource: 'remote-sdk', contextMode: item.value.endsWith('[1m]') ? '1m' : 'default', resolvedModel: item.resolvedModel, effort };
      add(option);
      if (item.resolvedModel && !aliases.has(modelBase(item.resolvedModel))) {
        const explicitId = item.resolvedModel + (option.contextMode === '1m' && !item.resolvedModel.endsWith('[1m]') ? '[1m]' : '');
        add({ ...rows.get(explicitId), ...option, value: explicitId, label: modelBase(explicitId), selectionKind: 'version' });
      }
    }
    const configured = [settings.model, settings.defaultModel, effectiveEnv.ANTHROPIC_MODEL, effectiveEnv.ANTHROPIC_DEFAULT_MODEL, ...['OPUS', 'SONNET', 'HAIKU', 'FABLE'].map((alias) => effectiveEnv[`ANTHROPIC_DEFAULT_${alias}_MODEL`])];
    for (const value of configured) {
      const id = string(value);
      if (id && !aliases.has(modelBase(id)) && !rows.has(id)) add({ value: id, label: modelBase(id), selectionKind: 'version', catalogSource: 'remote-config', contextMode: id.endsWith('[1m]') ? '1m' : 'default' });
    }
    // Do not promise models that the machine's explicit Claude settings exclude.
    const allowlist = Array.isArray(settings.availableModels) ? settings.availableModels.filter((item): item is string => typeof item === 'string') : null;
    const options = [...rows.values()].filter((option) => option.value === 'default' || !allowlist || allowlist.some((allowed) => option.value === allowed || option.value.startsWith(`${allowed}[`) || (aliases.has(allowed) && (option.value.startsWith(`claude-${allowed}-`) || modelBase(option.value) === allowed))));
    return { DEFAULT: 'default', OPTIONS: options };
  };
}
