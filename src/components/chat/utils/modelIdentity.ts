import type { ProviderModelOption } from '../../../types/app';

/** Keep the wire ID intact; only the context suffix is a separate UI choice. */
export function modelVersionKey(option: Pick<ProviderModelOption, 'value'>): string {
  return option.value.replace(/\[1m\]$/i, '');
}

export function uniqueModelVersions(options: ProviderModelOption[]): ProviderModelOption[] {
  const byVersion = new Map<string, ProviderModelOption>();
  for (const option of options) {
    const key = modelVersionKey(option);
    if (!byVersion.has(key) || option.contextMode === 'default') byVersion.set(key, option);
  }
  return [...byVersion.values()];
}

/** Only choose a context variant the remote actually supplied. */
export function selectModelVersion(options: ProviderModelOption[], version: ProviderModelOption, current: ProviderModelOption | null): string {
  return options.find((option) => modelVersionKey(option) === modelVersionKey(version) && option.contextMode === current?.contextMode)?.value ?? version.value;
}
