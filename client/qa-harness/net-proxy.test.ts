import net, { type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startNetProxyLane, type NetProxyLane } from './net-proxy';

const lanes: NetProxyLane[] = [];
const servers: Server[] = [];
const sockets: Socket[] = [];

async function startEchoServer() {
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on('data', (chunk) => socket.write(chunk));
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing server address');
  return { server, port: address.port };
}

async function connect(port: number) {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  socket.setNoDelay(true);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return socket;
}

function readBytes(socket: Socket, count: number, timeoutMs = 1000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${count} byte(s), got ${total}`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= count) {
        cleanup();
        resolve(Buffer.concat(chunks, total).subarray(0, count));
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error('socket closed while waiting for data'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('close', onClose);
    };
    socket.on('data', onData);
    socket.once('close', onClose);
  });
}

async function startLane(targetPort: number, delayMs: number, jitterMs = 0) {
  const lane = await startNetProxyLane({
    targetHost: '127.0.0.1',
    targetPort,
    profile: { delayMs, jitterMs },
  });
  lanes.push(lane);
  return lane;
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const lane of lanes.splice(0)) await lane.close().catch(() => undefined);
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('net-proxy', () => {
  it('adds delay in both TCP directions', async () => {
    const { port } = await startEchoServer();
    const lane = await startLane(port, 35);
    const socket = await connect(lane.port);

    const started = performance.now();
    socket.write('x');
    const data = await readBytes(socket, 1);
    const elapsed = performance.now() - started;

    expect(data.toString()).toBe('x');
    expect(elapsed).toBeGreaterThanOrEqual(55);
    expect(elapsed).toBeLessThan(300);
  });

  it('preserves byte ordering when jitter is enabled', async () => {
    const { port } = await startEchoServer();
    const lane = await startLane(port, 20, 80);
    const socket = await connect(lane.port);

    for (const part of ['a', 'b', 'c', 'd', 'e']) {
      socket.write(part);
    }

    const data = await readBytes(socket, 5, 1500);
    expect(data.toString()).toBe('abcde');
  });

  it('keeps already-scheduled chunks on their original delay after setProfile', async () => {
    const { port } = await startEchoServer();
    const lane = await startLane(port, 90);
    const socket = await connect(lane.port);

    const firstStarted = performance.now();
    socket.write('a');
    await new Promise((resolve) => setTimeout(resolve, 15));
    lane.setProfile({ delayMs: 0, jitterMs: 0 });

    expect((await readBytes(socket, 1)).toString()).toBe('a');
    const firstElapsed = performance.now() - firstStarted;
    expect(firstElapsed).toBeGreaterThanOrEqual(70);

    const secondStarted = performance.now();
    socket.write('b');
    expect((await readBytes(socket, 1)).toString()).toBe('b');
    const secondElapsed = performance.now() - secondStarted;
    expect(secondElapsed).toBeLessThan(60);
  });

  it('simulates a disconnect with dropAfterMs', async () => {
    const { port } = await startEchoServer();
    const lane = await startNetProxyLane({
      targetHost: '127.0.0.1',
      targetPort: port,
      profile: { delayMs: 0, jitterMs: 0, dropAfterMs: 40 },
    });
    lanes.push(lane);
    const socket = await connect(lane.port);

    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    await closed;
    expect(socket.destroyed).toBe(true);
  });
});