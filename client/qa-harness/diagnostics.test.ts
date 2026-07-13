import { describe, expect, it } from 'vitest';
import { diagnoseRun, parseNdjson } from './diagnostics';

function frame(
  t: number,
  phase: string,
  opts: {
    x?: number;
    z?: number;
    corr?: number;
    joined?: number;
    fire?: number;
    tick?: string;
  } = {},
) {
  const hasPos = opts.x != null || opts.z != null;
  return {
    type: 'frame',
    t,
    phase,
    simPosition: hasPos ? { x: opts.x ?? 0, y: 100, z: opts.z ?? 0 } : null,
    renderPosition: hasPos ? { x: opts.x ?? 0, y: 100, z: opts.z ?? 0 } : null,
    localServerTick: opts.tick ?? '1',
    localCorrectionError: opts.corr ?? 0,
    offsetLength: 0,
    channels: {
      isJoined: opts.joined ?? (hasPos ? 1 : 0),
      fireballProjectiles: opts.fire ?? 0,
      lightningEffects: 0,
      combatFeedbackEffects: 0,
      hp: 100,
      config_walkSpeed: 6,
      config_sprintMultiplier: 1.8,
    },
  };
}

describe('diagnostics', () => {
  it('flags severe rAF stalls and under-movement after hitch', () => {
    const lines = [
      JSON.stringify({ type: 'meta', characterClass: 'paladin', label: 't', clientUrl: 'http://x/beta/' }),
      // ~1.5s walk that only advances 1.8 units because of a multi-second stall
      ...Array.from({ length: 20 }, (_, i) =>
        JSON.stringify(frame(1000 + i * 16, 'walk_forward', { z: -i * 0.05, tick: String(100 + i) })),
      ),
      // 5s stall then a few more frames
      JSON.stringify(frame(1000 + 19 * 16 + 5000, 'walk_forward', { z: -1.8, tick: '150' })),
      JSON.stringify(frame(1000 + 19 * 16 + 5016, 'walk_forward', { z: -1.85, tick: '151' })),
    ];
    const text = lines.join('\n');
    const d = diagnoseRun('test.ndjson', text);
    expect(d.hitches.some((h) => h.dtMs >= 1000)).toBe(true);
    expect(d.concerns.some((c) => c.code === 'severe-frame-stall' || c.code === 'sparse-frames')).toBe(
      true,
    );
    expect(d.concerns.some((c) => c.code === 'under-movement')).toBe(true);
  });

  it('detects combat channel rise for wizard fireball', () => {
    const lines = [
      JSON.stringify({ type: 'meta', characterClass: 'wizard', label: 't', clientUrl: 'http://x/beta/' }),
      JSON.stringify(frame(0, 'cast_fireball', { x: 0, z: 0, fire: 0, joined: 1 })),
      JSON.stringify(frame(16, 'cast_fireball', { x: 0, z: 0, fire: 1, joined: 1 })),
      JSON.stringify(frame(32, 'cast_fireball', { x: 0, z: 0, fire: 1, joined: 1 })),
    ];
    const d = diagnoseRun('wiz.ndjson', lines.join('\n'));
    expect(d.combat.fireballSaw).toBe(true);
    expect(d.concerns.some((c) => c.code === 'combat-channel-missing' && c.message.includes('fireball'))).toBe(
      false,
    );
  });

  it('parseNdjson separates record types', () => {
    const text = [
      JSON.stringify({ type: 'meta', characterClass: 'wizard' }),
      JSON.stringify({ type: 'frame', t: 1, phase: 'a' }),
      JSON.stringify({ type: 'event', t: 2, kind: 'keydown' }),
      JSON.stringify({ type: 'longtask', duration: 80 }),
      JSON.stringify({ type: 'resource', name: 'x', transferSize: 1000 }),
    ].join('\n');
    const p = parseNdjson(text);
    expect(p.frames).toHaveLength(1);
    expect(p.events).toHaveLength(1);
    expect(p.longtasks).toHaveLength(1);
    expect(p.resources).toHaveLength(1);
  });
});
