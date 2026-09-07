declare global {
  interface Window {
    __REMOTE_BASE__?: string;
    __REMOTE_ID__?: string;
    __REMOTE_NAME__?: string;
    __REMOTE_HUB__?: boolean;
    __CLOUDCLI_EMBEDDED__?: boolean;
    __CLOUDCLI_SIDE_CHAT__?: boolean;
  }
}
export const remoteStorageKey = (remoteId: string, key: string) => `cloudcli:remote:${remoteId}:${key}`;

/** Resolve transport only, leaving native session IDs and file paths untouched. */
export function remoteTransportUrl(value: string, origin: string, base: string): string {
  const url = new URL(value, origin);
  if (url.host !== new URL(origin).host || !['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return value;
  if (!/^\/(?:api(?:\/|$)|health$|ws$|shell$)/.test(url.pathname)) return value;
  url.pathname = base + url.pathname;
  return url.href;
}

/** Each embedded remote owns its auth, drafts, model choices and session state. */
export function scopedRemoteStorage(storage: Storage, remoteId: string): Storage {
  const prefix = remoteStorageKey(remoteId, '');
  const keys = () => Array.from({
    length: storage.length
  }, (_, i) => storage.key(i)).filter((key): key is string => Boolean(key?.startsWith(prefix)));
  return {
    get length() {
      return keys().length;
    },
    key: index => keys()[index]?.slice(prefix.length) ?? null,
    getItem: key => storage.getItem(prefix + key),
    setItem: (key, value) => storage.setItem(prefix + key, value),
    removeItem: key => storage.removeItem(prefix + key),
    clear: () => keys().forEach(key => storage.removeItem(key))
  };
}

/** Installed before mounting embedded App; this entry imports no Claude runtime. */
export function installRemoteTransport() {
  const parameters = new URLSearchParams(window.location.search);
  window.__CLOUDCLI_EMBEDDED__ = parameters.has('embedded') || ['cloudcli-remote', 'cloudcli-side-chat'].includes(window.name);
  window.__CLOUDCLI_SIDE_CHAT__ = parameters.has('sideChat') || window.name === 'cloudcli-side-chat';
  const base = window.__REMOTE_BASE__;
  const id = window.__REMOTE_ID__;
  if (!base || !id) return;
  const resolve = (url: string) => remoteTransportUrl(url, window.location.origin, base);
  const storage = window.localStorage;
  const scoped = scopedRemoteStorage(storage, id);
  for (const key of ['userLanguage', 'theme']) {
    if (scoped.getItem(key) === null && storage.getItem(key) !== null) scoped.setItem(key, storage.getItem(key)!);
  }
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: scoped
  });
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => originalFetch(input instanceof Request ? new Request(resolve(input.url), input) : resolve(String(input)), init);
  const OriginalSocket = window.WebSocket;
  window.WebSocket = class extends OriginalSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(resolve(String(url)), protocols);
    }
  };
  const OriginalEvents = window.EventSource;
  window.EventSource = class extends OriginalEvents {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(resolve(String(url)), init);
    }
  };
  const OriginalRequest = window.XMLHttpRequest;
  window.XMLHttpRequest = class extends OriginalRequest {
    open(method: string, url: string | URL, async = true, username?: string | null, password?: string | null) {
      super.open(method, resolve(String(url)), async, username, password);
    }
  };
  // Modified-click links must stay on their owning remote too.
  document.addEventListener('click', event => {
    const anchor = (event.target as Element)?.closest<HTMLAnchorElement>('a[href]');
    if (anchor?.getAttribute('href')?.startsWith('/session/')) anchor.href = base + anchor.getAttribute('href');
  }, true);
}
