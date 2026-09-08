import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useTheme } from '@/shared/context/ThemeContext';
import { api } from '@/shared/api';
import { Button } from '@/shared/ui';
import { usePlugins } from '@/modules/plugins/context/PluginsContext';
import type { Project, ProjectSession } from '@/shared/types';

type PluginTabContentProps = {
  pluginName: string;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
};

type PluginContext = {
  theme: 'dark' | 'light';
  // Plugin contract historically used `name` for the project identifier; we
  // keep that key and populate it from the DB `projectId` so external plugins
  // continue to receive a stable opaque id.
  project: { name: string; path: string } | null;
  session: { id: string; title: string } | null;
};

function buildContext(
  isDarkMode: boolean,
  selectedProject: Project | null,
  selectedSession: ProjectSession | null,
): PluginContext {
  return {
    theme: isDarkMode ? 'dark' : 'light',
    project: selectedProject
      ? {
        name: selectedProject.projectId,
        path: selectedProject.fullPath || selectedProject.path || '',
      }
      : null,
    session: selectedSession
      ? {
        id: selectedSession.id,
        title: selectedSession.title || selectedSession.name || selectedSession.id,
      }
      : null,
  };
}

/** Rendered by the project-workspace module to host a plugin's own UI inside its workspace tab. */
export default function PluginTabContent({
  pluginName,
  selectedProject,
  selectedSession,
}: PluginTabContentProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  // Keep plugin errors outside its document so a broken UI cannot erase its recovery controls.
  const [loadError, setLoadError] = useState<string | null>(null);
  // Show progress until both import and the plugin's asynchronous mount complete.
  const [opening, setOpening] = useState(false);
  // Retry a failed remote bundle without replacing the conversation or workspace.
  const [loadAttempt, setLoadAttempt] = useState(0);
  const { isDarkMode } = useTheme();
  const { plugins, loading, pluginsError, refreshPlugins } = usePlugins();

  // Stable refs so effects don't need context values in their dep arrays
  const contextRef = useRef<PluginContext>(buildContext(isDarkMode, selectedProject, selectedSession));
  const contextCallbacksRef = useRef<Set<(ctx: PluginContext) => void>>(new Set());


  const plugin = plugins.find(p => p.name === pluginName);

  // Keep contextRef current and notify the mounted plugin on every context change
  useEffect(() => {
    const ctx = buildContext(isDarkMode, selectedProject, selectedSession);
    contextRef.current = ctx;

    for (const cb of contextCallbacksRef.current) {
      try { cb(ctx); } catch { /* plugin error — ignore */ }
    }
  }, [isDarkMode, selectedProject, selectedSession]);

  useEffect(() => {
    setLoadError(null);
    setOpening(Boolean(plugin?.enabled));
    if (!containerRef.current || !plugin?.enabled) return;

    let active = true;
    let frame: HTMLIFrameElement | null = null;
    let disposePlugin: (() => void) | undefined;
    let blobUrl: string | undefined;
    const container = containerRef.current;
    const contextCallbacks = contextCallbacksRef.current;
    const reportError = (error: unknown) => {
      if (!active) return;
      clearTimeout(timeout);
      setOpening(false);
      setLoadError(error instanceof Error ? error.message : String(error));
    };
    const timeout = setTimeout(() => reportError('Plugin did not finish opening. Retry, or check the plugin build and backend in Settings.'), 20_000);

    (async () => {
      try {
        const res = await api.plugins.asset(pluginName, plugin.entry || 'index.js');
        if (!res.ok) throw new Error(`Failed to fetch plugin (HTTP ${res.status})`);
        const jsText = await res.text();
        if (!active) return;
        blobUrl = URL.createObjectURL(new Blob([jsText], { type: 'application/javascript' }));
        frame = document.createElement('iframe');
        frame.title = plugin.displayName || pluginName;
        frame.className = 'h-full w-full border-0';
        // Separate document/JS realm prevents accidental body/root CSS and DOM
        // writes from replacing CloudCLI. Installed plugins remain trusted code;
        // same-origin compatibility is not a security sandbox.
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
        // A real same-origin document preserves location.host for plugin sockets.
        frame.src = new URL('/plugin-host.html', window.location.origin).href;
        frame.addEventListener('load', () => {
          if (!active || !frame?.contentWindow || !frame.contentDocument) return;
          const pluginWindow = frame.contentWindow;
          const pluginDocument = frame.contentDocument;
          // Reuse the owning workspace's already scoped transports/storage.
          // Native iframe globals would otherwise bypass the remote hub routing.
          Object.defineProperty(pluginWindow, 'localStorage', { configurable: true, value: window.localStorage });
          pluginWindow.fetch = (input, init) => window.fetch(
            typeof input === 'object' && 'url' in input ? new Request(input.url, input as Request) : String(input), init,
          );
          Object.assign(pluginWindow, {
            WebSocket: window.WebSocket, EventSource: window.EventSource, XMLHttpRequest: window.XMLHttpRequest,
            __REMOTE_BASE__: window.__REMOTE_BASE__, __REMOTE_ID__: window.__REMOTE_ID__, __REMOTE_NAME__: window.__REMOTE_NAME__,
          });
          const updateFrameTheme = (ctx: PluginContext) => {
            pluginDocument.documentElement.classList.toggle('dark', ctx.theme === 'dark');
            pluginDocument.documentElement.style.colorScheme = ctx.theme;
            pluginDocument.body.style.color = ctx.theme === 'dark' ? '#e7e5e4' : '#1c1917';
            pluginDocument.body.style.background = ctx.theme === 'dark' ? '#171717' : '#ffffff';
          };
          updateFrameTheme(contextRef.current);
          contextCallbacks.add(updateFrameTheme);
          const hostApi = {
            get context(): PluginContext { return contextRef.current; },
            onContextChange(cb: (ctx: PluginContext) => void): () => void {
              contextCallbacks.add(cb);
              return () => contextCallbacks.delete(cb);
            },
            async rpc(method: string, path: string, body?: unknown): Promise<unknown> {
              if (!active) throw new Error('Plugin workspace closed');
              const response = await api.plugins.rpc(pluginName, method, path, body);
              if (!response.ok) {
                const detail = await response.text();
                throw new Error(`RPC error ${response.status}: ${detail.slice(0, 500)}`);
              }
              if (response.status === 204) return null;
              return response.headers.get('content-type')?.includes('json') ? response.json() : response.text();
            },
          };
          Object.assign(pluginWindow, { __cloudcliPluginHost: {
            api: hostApi,
            ready(unmount: () => void) {
              if (!active) { unmount(); return; }
              disposePlugin = unmount;
              clearTimeout(timeout);
              setOpening(false);
            },
            failed: reportError,
          } });
          const script = pluginDocument.createElement('script');
          script.type = 'module';
          script.textContent = `
            const host = window.__cloudcliPluginHost;
            window.addEventListener('error', event => { if (event.message) host.failed(event.message); });
            window.addEventListener('unhandledrejection', event => host.failed(String(event.reason)));
            try {
              const mod = await import(${JSON.stringify(blobUrl)});
              if (typeof mod.mount !== 'function') throw new Error('The plugin entry must export mount(). Check the remote plugin build.');
              const root = document.getElementById('plugin-root');
              await mod.mount(root, host.api);
              host.ready(() => mod.unmount?.(root));
            } catch (error) { host.failed(String(error)); }
          `;
          pluginDocument.body.appendChild(script);
        }, { once: true });
        container.replaceChildren(frame);
      } catch (err) { reportError(err); }
    })();

    return () => {
      active = false;
      clearTimeout(timeout);
      try { disposePlugin?.(); } catch { /* Recovery remains owned by the host. */ }
      frame?.remove();
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      contextCallbacks.clear();
    };
  }, [pluginName, plugin?.entry, plugin?.enabled, plugin?.version, plugin?.assetRevision, plugin?.displayName, loadAttempt]);

  return (
    <div className="relative h-full w-full overflow-auto">
      <div ref={containerRef} className="h-full w-full overflow-auto" />
      {!plugin?.enabled && <div className="absolute inset-0 p-4 text-sm text-muted-foreground">
        {loading ? t('settings:pluginSettings.scanningPlugins') : plugin ? t('settings:pluginSettings.enableToOpen') : pluginsError || t('settings:pluginSettings.notAvailable')}
        <Button variant="outline" className="mt-3 block" onClick={() => void refreshPlugins()}>{t('settings:pluginSettings.refreshPlugins')}</Button>
      </div>}
      {opening && !loadError && <div role="status" className="absolute inset-0 bg-background p-4 text-sm text-muted-foreground">{t('common:misc.loading', { defaultValue: 'Opening plugin…' })}</div>}
      {loadError && (
        <div role="alert" className="absolute inset-0 overflow-auto bg-background p-4 text-[13px] text-red-600">
          {t('common:misc.pluginLoadFailed', { error: loadError })}
          <p className="mt-2 text-sm text-muted-foreground">{t('settings:pluginSettings.bundleRequirement', { defaultValue: 'Check that this plugin builds a self-contained, single-file browser bundle. Relative module imports and sibling assets resolved through import.meta.url are not supported by the authenticated loader.' })}</p>
          <Button variant="outline" className="mt-3 block" onClick={() => setLoadAttempt(value => value + 1)}>{t('settings:pluginSettings.retryOpen')}</Button>
        </div>
      )}
    </div>
  );
}
