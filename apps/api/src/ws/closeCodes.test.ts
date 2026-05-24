import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'net';
import { createServer, type Server } from 'http';
import WebSocket from 'ws';
import { attachWebSocket } from './handler.js';

let server: Server;
let port: number;

function waitForClose(url: string): Promise<{ code: number; reason: string; messages: unknown[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages: unknown[] = [];
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Timed out waiting for close'));
    }, 5000);

    ws.on('message', (raw) => {
      try {
        messages.push(JSON.parse(raw.toString()));
      } catch {
        messages.push(raw.toString());
      }
    });
    ws.on('close', (code, reason) => {
      clearTimeout(timeout);
      resolve({ code, reason: reason.toString(), messages });
    });
    ws.on('error', reject);
  });
}

before(async () => {
  server = createServer();
  attachWebSocket(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      port = address.port;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('WebSocket auth close codes', () => {
  it('closes missing token/sessionId as policy violation', async () => {
    const result = await waitForClose(`ws://127.0.0.1:${port}/ws?sessionId=00000000-0000-0000-0000-000000000000`);

    assert.equal(result.code, 1008);
    assert.equal(result.reason, 'Missing token or sessionId');
  });

  it('closes invalid token as policy violation', async () => {
    const result = await waitForClose(`ws://127.0.0.1:${port}/ws?token=bad-token&sessionId=00000000-0000-0000-0000-000000000000`);

    assert.equal(result.code, 1008);
    assert.equal(result.reason, 'Invalid token');
  });
});
