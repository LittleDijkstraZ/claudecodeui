import { WebSocket } from 'ws';

/**
 * Proxies an authenticated client websocket to a plugin websocket endpoint.
 */
export function handlePluginWsProxy(
  clientWs: WebSocket,
  pathname: string,
  getPluginPort: (pluginName: string) => number | null
): void {
  const pluginName = pathname.replace('/plugin-ws/', '');
  if (!pluginName || /[^a-zA-Z0-9_-]/.test(pluginName)) {
    clientWs.close(4400, 'Invalid plugin name');
    return;
  }

  const port = getPluginPort(pluginName);
  if (!port) {
    clientWs.close(4404, 'Plugin not running');
    return;
  }

  const upstream = new WebSocket(`ws://127.0.0.1:${port}/ws`, { handshakeTimeout: 8000 });
  const pending: Array<{ data: Buffer; binary: boolean }> = [];
  let pendingBytes = 0;

  upstream.on('open', () => {
    if (clientWs.readyState !== WebSocket.OPEN) { upstream.terminate(); return; }
    for (const item of pending) upstream.send(item.data, { binary: item.binary });
    pending.length = 0; pendingBytes = 0;
    console.log(`[Plugins] WS proxy connected to "${pluginName}" on port ${port}`);
  });

  upstream.on('message', (data, isBinary) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data, { binary: isBinary });
    }
  });

  clientWs.on('message', (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
    } else if (upstream.readyState === WebSocket.CONNECTING) {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if ((pendingBytes += buffer.length) > 1024 * 1024) {
        clientWs.close(1013, 'Plugin is not ready; retry the connection');
        upstream.terminate();
      } else pending.push({ data: buffer, binary: isBinary });
    }
  });

  upstream.on('close', () => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close();
    }
  });

  clientWs.on('close', () => {
    pending.length = 0; pendingBytes = 0;
    if (upstream.readyState === WebSocket.OPEN) upstream.close();
    else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
  });

  upstream.on('error', (error) => {
    console.error(`[Plugins] WS proxy error for "${pluginName}":`, error.message);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(4502, 'Upstream error');
    }
  });

  clientWs.on('error', () => {
    pending.length = 0; pendingBytes = 0;
    if (upstream.readyState === WebSocket.OPEN) upstream.close();
    else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
  });
}
