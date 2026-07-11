/**
 * In-process TCP shaping proxy for the QA harness.
 *
 * CDP network emulation is not dependable for already-established WebSocket
 * transports, so latency-sensitive QA runs need a real socket hop in front of
 * SpacetimeDB. This relay shapes delay/jitter/throughput and can simulate a
 * hard disconnect. True packet loss is not expressible over TCP: the transport
 * guarantees delivery and ordering until the connection is broken.
 */
import net, { type Server, type Socket } from 'node:net';

export type NetProfile = {
  delayMs: number;
  jitterMs: number;
  throughputBytesPerSec?: number;
  dropAfterMs?: number;
  /**
   * Periodic latency burst riding on top of the base delay: for the first
   * `durationMs` of every `periodMs` window (clocked from when the profile
   * was applied), delay is `delayMs` instead of the base. Steady latency did
   * not reproduce #216's reconciliation teleport — the hypothesis is that the
   * *transition* into/out of elevated latency does, so bursts are the
   * experiment steady grids can't run.
   */
  burst?: {
    periodMs: number;
    durationMs: number;
    delayMs: number;
    /** Defaults to the base profile's jitterMs. */
    jitterMs?: number;
  };
};

export interface NetProxyLane {
  port: number;
  setProfile(profile: NetProfile): void;
  close(): Promise<void>;
}

type ScheduledChunk = {
  chunk: Buffer;
  flushAt: number;
};

function normalizeProfile(profile: NetProfile): NetProfile {
  return {
    delayMs: Math.max(0, profile.delayMs),
    jitterMs: Math.max(0, profile.jitterMs),
    ...(profile.throughputBytesPerSec && profile.throughputBytesPerSec > 0
      ? { throughputBytesPerSec: profile.throughputBytesPerSec }
      : {}),
    ...(profile.dropAfterMs && profile.dropAfterMs > 0 ? { dropAfterMs: profile.dropAfterMs } : {}),
    ...(profile.burst && profile.burst.periodMs > 0 && profile.burst.durationMs > 0
      ? {
          burst: {
            periodMs: profile.burst.periodMs,
            durationMs: Math.min(profile.burst.durationMs, profile.burst.periodMs),
            delayMs: Math.max(0, profile.burst.delayMs),
            ...(profile.burst.jitterMs != null ? { jitterMs: Math.max(0, profile.burst.jitterMs) } : {}),
          },
        }
      : {}),
  };
}

/**
 * The flat profile in effect at `elapsedMs` since the profile was applied:
 * the burst window's delay during bursts, the base otherwise. Downstream
 * (sampleDelayMs, throughput shaping) stays burst-unaware.
 */
export function effectiveProfileAt(profile: NetProfile, elapsedMs: number): NetProfile {
  const burst = profile.burst;
  if (!burst) return profile;
  const inBurst = elapsedMs >= 0 && elapsedMs % burst.periodMs < burst.durationMs;
  if (!inBurst) return profile;
  return {
    ...profile,
    delayMs: burst.delayMs,
    jitterMs: burst.jitterMs ?? profile.jitterMs,
  };
}

function sampleDelayMs(profile: NetProfile) {
  const jitter = profile.jitterMs > 0 ? (Math.random() * 2 - 1) * profile.jitterMs : 0;
  return Math.max(0, profile.delayMs + jitter);
}

class DirectionScheduler {
  private readonly queue: ScheduledChunk[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextAllowedFlushAt = 0;
  private closed = false;

  constructor(private readonly destination: Socket) {}

  enqueue(chunk: Buffer, profile: NetProfile) {
    if (this.closed || this.destination.destroyed) return;

    const now = Date.now();
    let flushAt = Math.max(now + sampleDelayMs(profile), this.nextAllowedFlushAt);

    if (profile.throughputBytesPerSec) {
      // TCP exposes an ordered byte stream, not packets. This is a deliberately
      // simple shaping approximation: each chunk reserves enough future time to
      // serialize its bytes at the requested rate, so sustained throughput stays
      // under the configured budget even though writes still happen chunkwise.
      flushAt += (chunk.length / profile.throughputBytesPerSec) * 1000;
    }

    this.nextAllowedFlushAt = flushAt;
    this.queue.push({ chunk: Buffer.from(chunk), flushAt });
    this.scheduleNext();
  }

  close() {
    this.closed = true;
    this.queue.length = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private scheduleNext() {
    if (this.closed || this.timer || this.queue.length === 0) return;

    const waitMs = Math.max(0, this.queue[0].flushAt - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushDue();
      this.scheduleNext();
    }, waitMs);
  }

  private flushDue() {
    const now = Date.now();
    while (!this.closed && this.queue.length > 0 && this.queue[0].flushAt <= now) {
      const item = this.queue.shift()!;
      if (!this.destination.destroyed) {
        this.destination.write(item.chunk);
      }
    }
  }
}

class NetProxyLaneImpl implements NetProxyLane {
  private profile: NetProfile;
  // Burst windows are clocked from the moment the profile was applied, so a
  // mid-run setProfile restarts the cycle predictably at a phase boundary.
  private profileAppliedAt = Date.now();
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private closed = false;

  port = 0;

  constructor(
    private readonly targetHost: string,
    private readonly targetPort: number,
    initialProfile: NetProfile,
  ) {
    this.profile = normalizeProfile(initialProfile);
    this.server = net.createServer((client) => this.accept(client));
  }

  async listen(listenPort: number) {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        this.server.off('error', onError);
        const address = this.server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('net proxy did not receive a TCP listen address'));
          return;
        }
        this.port = address.port;
        resolve();
      };

      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(listenPort, '127.0.0.1');
    });
  }

  setProfile(profile: NetProfile) {
    this.profile = normalizeProfile(profile);
    this.profileAppliedAt = Date.now();
  }

  private profileNow(): NetProfile {
    return effectiveProfileAt(this.profile, Date.now() - this.profileAppliedAt);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;

    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();

    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private accept(client: Socket) {
    client.setNoDelay(true);
    if (this.closed) {
      client.destroy();
      return;
    }

    const upstream = net.createConnection({ host: this.targetHost, port: this.targetPort });
    upstream.setNoDelay(true);
    this.sockets.add(client);
    this.sockets.add(upstream);

    const clientToServer = new DirectionScheduler(upstream);
    const serverToClient = new DirectionScheduler(client);
    let cleaned = false;
    let dropTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clientToServer.close();
      serverToClient.close();
      client.destroy();
      upstream.destroy();
      this.sockets.delete(client);
      this.sockets.delete(upstream);
      if (dropTimer) clearTimeout(dropTimer);
    };

    // True packet loss is not expressible over a TCP relay: TCP guarantees
    // ordered delivery or connection failure at the transport layer. This timer
    // can only simulate a hard disconnect/reconnect event by destroying both
    // sockets after the configured connection age.
    const dropAfterMs = this.profile.dropAfterMs;
    dropTimer = dropAfterMs ? setTimeout(cleanup, dropAfterMs) : null;

    client.on('data', (chunk) => clientToServer.enqueue(chunk, this.profileNow()));
    upstream.on('data', (chunk) => serverToClient.enqueue(chunk, this.profileNow()));

    client.once('error', cleanup);
    upstream.once('error', cleanup);
    client.once('close', cleanup);
    upstream.once('close', cleanup);
  }
}

export async function startNetProxyLane(opts: {
  targetHost: string;
  targetPort: number;
  listenPort?: number;
  profile: NetProfile;
}): Promise<NetProxyLane> {
  const lane = new NetProxyLaneImpl(opts.targetHost, opts.targetPort, opts.profile);
  await lane.listen(opts.listenPort ?? 0);
  return lane;
}