import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';

import { handlePluginWsProxy } from '../services/plugin-websocket-proxy.service.js';

test('plugin terminal initialization sent immediately is preserved until its upstream handshake finishes', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const client = Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN as number,
    send(data: unknown, options: { binary: boolean }) { client.emit('reply', data, options.binary); },
    close() { client.readyState = WebSocket.CLOSED; client.emit('close'); },
  });
  try {
    server.on('connection', socket => { socket.on('message', (data, binary) => socket.send(data, { binary })); });
    const reply = once(client, 'reply');
    handlePluginWsProxy(client as unknown as WebSocket, '/plugin-ws/fixture', () => port);
    client.emit('message', Buffer.from('initial-resize-and-start'), false);
    const [data, binary] = await reply;
    assert.equal(String(data), 'initial-resize-and-start');
    assert.equal(binary, false);
  } finally {
    client.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('a plugin connection closed during startup does not leave an orphan upstream', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const client = Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN as number,
    send() { assert.fail('Closed plugin received output'); },
    close() { client.readyState = WebSocket.CLOSED; client.emit('close'); },
  });
  handlePluginWsProxy(client as unknown as WebSocket, '/plugin-ws/fixture', () => port);
  client.close();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(server.clients.size, 0);
  await new Promise<void>(resolve => server.close(() => resolve()));
});
