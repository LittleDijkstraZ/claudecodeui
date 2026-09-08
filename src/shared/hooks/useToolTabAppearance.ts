import { useSyncExternalStore } from 'react';

import type { WorkspaceToolTabAppearance } from '@/shared/types';

const STORAGE_KEY = 'cloudcli.workspace-tool-tab-appearance';
const CHANGE_EVENT = 'cloudcli:tool-tab-appearance';
// Keep the choice usable for this page if browser storage is unavailable.
let memoryFallback: WorkspaceToolTabAppearance | null = null;

function browserStorage() {
  return window.__CLOUDCLI_BROWSER_STORAGE__ ?? window.localStorage;
}

function readAppearance(): WorkspaceToolTabAppearance {
  if (memoryFallback) return memoryFallback;
  try {
    return browserStorage().getItem(STORAGE_KEY) === 'icons-and-text' ? 'icons-and-text' : 'icons';
  } catch {
    return 'icons';
  }
}

function subscribe(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.storageArea && event.storageArea !== browserStorage()) return;
    if (event.key !== null && event.key !== STORAGE_KEY) return;
    memoryFallback = null;
    onChange();
  };
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener('storage', onStorage);
  };
}

function setAppearance(value: WorkspaceToolTabAppearance) {
  const appearance = value === 'icons-and-text' ? 'icons-and-text' : 'icons';
  try {
    browserStorage().setItem(STORAGE_KEY, appearance);
    memoryFallback = null;
  } catch {
    memoryFallback = appearance;
  }
  // Storage events reach the other same-origin hub frames; this event updates
  // every consumer in the settings frame without writing any remote config.
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Shared by settings and workspace/hub toolbars; this preference belongs to the browser, not a remote account. */
export function useToolTabAppearance() {
  const appearance = useSyncExternalStore(subscribe, readAppearance, () => 'icons' as const);
  return [appearance, setAppearance] as const;
}
