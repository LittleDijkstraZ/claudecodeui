import type { ProviderModelOption } from '@/shared/types';

/** Used by the model menu to separate the context suffix while preserving wire IDs. */
export function modelVersionKey(option: Pick<ProviderModelOption, 'value'>): string {
  return option.value.replace(/\[1m\]$/i, '');
}

/** Used by the model menu to list each supplied version once across context variants. */
export function uniqueModelVersions(options: ProviderModelOption[]): ProviderModelOption[] {
  const byVersion = new Map<string, ProviderModelOption>();
  for (const option of options) {
    const key = modelVersionKey(option);
    if (!byVersion.has(key) || option.contextMode === 'default') byVersion.set(key, option);
  }
  return [...byVersion.values()];
}

/** Used by the model menu to select only context variants the remote actually supplied. */
export function selectModelVersion(options: ProviderModelOption[], version: ProviderModelOption, current: ProviderModelOption | null): string {
  return options.find((option) => modelVersionKey(option) === modelVersionKey(version) && option.contextMode === current?.contextMode)?.value ?? version.value;
}
