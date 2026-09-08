import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { api } from '@/shared/api';
import type { Plugin, PluginActionResult } from '@/shared/types';


type PluginsContextValue = {
  plugins: Plugin[];
  loading: boolean;
  pluginsError: string | null;
  refreshPlugins: () => Promise<void>;
  installPlugin: (url: string) => Promise<PluginActionResult>;
  uninstallPlugin: (name: string) => Promise<PluginActionResult>;
  updatePlugin: (name: string) => Promise<PluginActionResult>;
  togglePlugin: (name: string, enabled: boolean) => Promise<PluginActionResult>;
};

// Repository manifests are external JSON; optional package-style metadata must
// never become object-valued React children and erase the settings page.
function normalizePlugin(value: unknown): Plugin | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(item.name)) return null;
  const text = (field: unknown, fallback = '') => typeof field === 'string' ? field : fallback;
  const authorName = item.author && typeof item.author === 'object' && 'name' in item.author ? item.author.name : item.author;
  return {
    name: item.name, displayName: text(item.displayName, item.name), entry: text(item.entry, 'index.js'),
    version: typeof item.version === 'number' ? String(item.version) : text(item.version, '0.0.0'),
    assetRevision: typeof item.assetRevision === 'string' ? item.assetRevision : undefined,
    description: text(item.description), author: text(authorName), icon: text(item.icon, 'Puzzle'),
    type: item.type === 'react' ? 'react' : 'module', slot: 'tab',
    server: typeof item.server === 'string' ? item.server : null,
    permissions: Array.isArray(item.permissions) ? item.permissions.filter((permission): permission is string => typeof permission === 'string') : [],
    enabled: item.enabled === true, serverRunning: item.serverRunning === true,
    dirName: text(item.dirName, item.name), repoUrl: typeof item.repoUrl === 'string' ? item.repoUrl : null,
    serverError: typeof item.serverError === 'string' ? item.serverError : null,
  };
}

const PluginsContext = createContext<PluginsContextValue | null>(null);

export function usePlugins() {
  const context = useContext(PluginsContext);
  if (!context) {
    throw new Error('usePlugins must be used within a PluginsProvider');
  }
  return context;
}

/** Mounted by the app root so the plugins and project-workspace modules can read and mutate installed plugins through usePlugins. */
export function PluginsProvider({ children }: { children: ReactNode }) {
  // Keep the last successful remote inventory visible while refreshing or disconnected.
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  // Only the initial inventory blocks rendering; later refreshes retain existing entries.
  const [loading, setLoading] = useState(true);
  // Surface inventory failures independently of installation outcomes.
  const [pluginsError, setPluginsError] = useState<string | null>(null);
  const requestVersion = useRef(0);
  const providerGeneration = useRef(0);
  const changes = useRef<BroadcastChannel | null>(null);

  const refreshPlugins = useCallback(async () => {
    const version = ++requestVersion.current;
    try {
      const res = await api.plugins.list();
      if (res.ok) {
        const data = await res.json();
        if (version !== requestVersion.current) return;
        if (!Array.isArray(data.plugins)) throw new Error('Remote plugin inventory is invalid. Refresh plugins to retry.');
        setPlugins(data.plugins.map(normalizePlugin).filter((plugin: Plugin | null): plugin is Plugin => Boolean(plugin)));
        setPluginsError(null);
      } else {
        let errorMessage = `Failed to fetch plugins (${res.status})`;
        try {
          const data = await res.json();
          errorMessage = data.details || data.error || errorMessage;
        } catch {
          errorMessage = res.statusText || errorMessage;
        }
        if (version === requestVersion.current) setPluginsError(errorMessage);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch plugins';
      if (version === requestVersion.current) setPluginsError(message);
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    ++providerGeneration.current;
    void refreshPlugins();
    const refresh = () => { void refreshPlugins(); };
    window.addEventListener('focus', refresh);
    // A channel only invalidates this machine's inventory; no plugin data or credentials travel across it.
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(`cloudcli-plugins:${window.__REMOTE_BASE__ || location.origin}`);
    changes.current = channel;
    if (channel) channel.onmessage = refresh;
    return () => {
      ++providerGeneration.current;
      ++requestVersion.current;
      window.removeEventListener('focus', refresh);
      channel?.close();
      changes.current = null;
    };
  }, [refreshPlugins]);

  const installPlugin = useCallback(async (url: string) => {
    const generation = providerGeneration.current;
    ++requestVersion.current;
    try {
      const res = await api.plugins.install(url);
      const data = await res.json();
      if (res.ok) {
        if (generation !== providerGeneration.current) return { success: true, pluginName: data.plugin?.name };
        // Only a server-confirmed inventory entry supplies enabled/entry state;
        // older servers return a raw manifest, which must not be guessed here.
        if (data.inventoryConfirmed === true && typeof data.plugin?.name === 'string'
          && typeof data.plugin?.enabled === 'boolean' && typeof data.plugin?.entry === 'string') {
          const installed = normalizePlugin(data.plugin);
          if (installed) {
            ++requestVersion.current;
            setPlugins(current => [...current.filter(plugin => plugin.name !== installed.name), installed]);
          }
        }
        await refreshPlugins();
        changes.current?.postMessage('changed');
        return { success: true, pluginName: data.plugin?.name, warning: data.warning || data.plugin?.serverError || null };
      }
      return { success: false, error: data.details || data.error || 'Install failed' };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Install failed' };
    }
  }, [refreshPlugins]);

  const uninstallPlugin = useCallback(async (name: string) => {
    ++requestVersion.current;
    try {
      const res = await api.plugins.uninstall(name);
      const data = await res.json();
      if (res.ok) {
        await refreshPlugins();
        changes.current?.postMessage('changed');
        return { success: true };
      }
      return { success: false, error: data.details || data.error || 'Uninstall failed' };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Uninstall failed' };
    }
  }, [refreshPlugins]);

  const updatePlugin = useCallback(async (name: string) => {
    ++requestVersion.current;
    try {
      const res = await api.plugins.update(name);
      const data = await res.json();
      if (res.ok) {
        await refreshPlugins();
        changes.current?.postMessage('changed');
        return { success: true, pluginName: name, warning: data.warning || null };
      }
      return { success: false, error: data.details || data.error || 'Update failed' };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Update failed' };
    }
  }, [refreshPlugins]);

  const togglePlugin = useCallback(async (name: string, enabled: boolean): Promise<PluginActionResult> => {
    ++requestVersion.current;
    try {
      const res = await api.plugins.toggle(name, enabled);
      if (!res.ok) {
        let errorMessage = `Toggle failed (${res.status})`;
        try {
          const data = await res.json();
          errorMessage = data.details || data.error || errorMessage;
        } catch {
          // response body wasn't JSON, use status text
          errorMessage = res.statusText || errorMessage;
        }
        return { success: false, error: errorMessage };
      }
      const data = await res.json();
      await refreshPlugins();
      changes.current?.postMessage('changed');
      return { success: true, error: null, warning: data.warning || null };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Toggle failed' };
    }
  }, [refreshPlugins]);

  // Built once per change: an inline object would re-render every consumer on
  // any render of this provider.
  const value = useMemo(
    () => ({ plugins, loading, pluginsError, refreshPlugins, installPlugin, uninstallPlugin, updatePlugin, togglePlugin }),
    [installPlugin, loading, plugins, pluginsError, refreshPlugins, togglePlugin, uninstallPlugin, updatePlugin],
  );

  return (
    <PluginsContext.Provider value={value}>
      {children}
    </PluginsContext.Provider>
  );
}
