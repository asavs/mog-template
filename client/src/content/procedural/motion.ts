/**
 * Procedural motion library — programmer-art clips for every MOTION_KEYS entry.
 *
 * Authored against the canonical T-pose rest. Limbs ROTATE only; hips may also
 * translate for weight / crouch / collapse. Track paths use canonical bone
 * names from `ctx.boneName` so they bind to the procedural body.
 *
 * Timing and beats follow `docs/motion-vocabulary.md` §2–3.
 */

import * as THREE from 'three';
import { registerMotionGenerator } from '../registry';
import {
  MOTION_ACTION,
  MOTION_AIR,
  MOTION_LOCOMOTION,
  MOTION_REACTION,
  MOTION_STANCE,
  motionIdFromKey,
} from '../keys';
import type { MotionGeneratorContext } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type EulerXYZ = readonly [number, number, number];

type RotKey = {
  t: number;
  /** Degrees, local XYZ. */
  e: EulerXYZ;
};

type PosKey = {
  t: number;
  /** Local position. */
  p: readonly [number, number, number];
};

const DEG = Math.PI / 180;
const _e = new THREE.Euler();
const _q = new THREE.Quaternion();

function eulerDegToQuat(x: number, y: number, z: number): THREE.Quaternion {
  _e.set(x * DEG, y * DEG, z * DEG, 'XYZ');
  return _q.setFromEuler(_e).clone();
}

/** Smoothstep-style ease in-out on [0,1]. */
function easeInOut(u: number): number {
  const t = THREE.MathUtils.clamp(u, 0, 1);
  return t * t * (3 - 2 * t);
}

/** Slow-out of anticipation (fast start of blend → wait). */
function easeOut(u: number): number {
  const t = THREE.MathUtils.clamp(u, 0, 1);
  return 1 - (1 - t) * (1 - t);
}

/** Snap into contact (slow then rush). */
function easeIn(u: number): number {
  const t = THREE.MathUtils.clamp(u, 0, 1);
  return t * t;
}

function lerpEuler(a: EulerXYZ, b: EulerXYZ, u: number): EulerXYZ {
  return [
    a[0] + (b[0] - a[0]) * u,
    a[1] + (b[1] - a[1]) * u,
    a[2] + (b[2] - a[2]) * u,
  ] as const;
}

function lerpPos(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  u: number,
): readonly [number, number, number] {
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}

/**
 * Expand sparse pose keys into denser eased samples so tracks don't linearize.
 * `ease` controls parameterisation between consecutive authored keys.
 */
function densifyRot(keys: RotKey[], samplesPerSegment = 3, ease: (u: number) => number = easeInOut): RotKey[] {
  if (keys.length < 2) return keys;
  const out: RotKey[] = [];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    out.push(a);
    const dt = b.t - a.t;
    if (dt <= 1e-6) continue;
    for (let s = 1; s <= samplesPerSegment; s++) {
      const u = s / (samplesPerSegment + 1);
      const eu = ease(u);
      out.push({ t: a.t + dt * u, e: lerpEuler(a.e, b.e, eu) });
    }
  }
  out.push(keys[keys.length - 1]);
  return out;
}

function densifyPos(keys: PosKey[], samplesPerSegment = 3, ease: (u: number) => number = easeInOut): PosKey[] {
  if (keys.length < 2) return keys;
  const out: PosKey[] = [];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    out.push(a);
    const dt = b.t - a.t;
    if (dt <= 1e-6) continue;
    for (let s = 1; s <= samplesPerSegment; s++) {
      const u = s / (samplesPerSegment + 1);
      const eu = ease(u);
      out.push({ t: a.t + dt * u, p: lerpPos(a.p, b.p, eu) });
    }
  }
  out.push(keys[keys.length - 1]);
  return out;
}

function rotTrack(boneName: string, keys: RotKey[], ease: (u: number) => number = easeInOut): THREE.QuaternionKeyframeTrack {
  const dense = densifyRot(keys, 3, ease);
  const times = dense.map(k => k.t);
  const values: number[] = [];
  for (const k of dense) {
    const q = eulerDegToQuat(k.e[0], k.e[1], k.e[2]);
    values.push(q.x, q.y, q.z, q.w);
  }
  return new THREE.QuaternionKeyframeTrack(`${boneName}.quaternion`, times, values);
}

function posTrack(boneName: string, keys: PosKey[], ease: (u: number) => number = easeInOut): THREE.VectorKeyframeTrack {
  const dense = densifyPos(keys, 3, ease);
  const times = dense.map(k => k.t);
  const values: number[] = [];
  for (const k of dense) {
    values.push(k.p[0], k.p[1], k.p[2]);
  }
  return new THREE.VectorKeyframeTrack(`${boneName}.position`, times, values);
}

/**
 * Natural hang from T-pose rest (arms along ±X).
 *
 * Rest leaves upper arms unrotated, so any clip that omits these reads as a
 * frozen T-pose — the worst placeholder failure mode. ~80° about Z drops the
 * arm to the side (75–85° band); a few degrees of X tips it slightly forward;
 * the residual from 90° is the outward splay so elbows clear the hips.
 * Pair with a small lower-arm bend so the limb is not a rigid plank.
 */
const ARM_DOWN_L: EulerXYZ = [6, 4, -80];
const ARM_DOWN_R: EulerXYZ = [6, -4, 80];
/** Soft elbow flex used whenever arms are in the hang baseline. */
const ELBOW_HANG: EulerXYZ = [18, 0, 0];
const ZERO: EulerXYZ = [0, 0, 0];

function hipsPos(ctx: MotionGeneratorContext, yOffset = 0, x = 0, z = 0): readonly [number, number, number] {
  const o = ctx.restPose.offsets.hips ?? [0, 1.09, 0];
  return [o[0] + x, o[1] + yOffset, o[2] + z];
}

function clip(ctx: MotionGeneratorContext, duration: number, tracks: THREE.KeyframeTrack[]): THREE.AnimationClip {
  return new THREE.AnimationClip(motionIdFromKey(ctx.key), duration, tracks);
}

// ---------------------------------------------------------------------------
// Locomotion
// ---------------------------------------------------------------------------

type GaitOpts = {
  duration: number;
  /** Leg swing amplitude degrees at the hip. */
  stride: number;
  armSwing: number;
  lean: number;
  hipBob: number;
  counterRot: number;
  direction: 'f' | 'b' | 'l' | 'r';
};

function gaitClip(ctx: MotionGeneratorContext, opts: GaitOpts): THREE.AnimationClip {
  const { duration, stride, armSwing, lean, hipBob, counterRot, direction } = opts;
  const n = (id: string) => ctx.boneName(id);
  const half = duration / 2;
  const tracks: THREE.KeyframeTrack[] = [];

  // Phase: 0 = left foot forward / right back (or lateral equiv).
  const phaseSign = direction === 'b' ? -1 : 1;
  const strideScale = direction === 'b' ? 0.8 : 1;
  const s = stride * strideScale * phaseSign;

  // Forward/back: rotate upper legs around X. Left/right: around Z for lateral.
  const legAxis = direction === 'l' || direction === 'r' ? 'lateral' : 'sagittal';
  const lateralSign = direction === 'l' ? 1 : direction === 'r' ? -1 : 0;

  const upperLegKeys = (side: 'L' | 'R'): RotKey[] => {
    const sign = side === 'L' ? 1 : -1;
    if (legAxis === 'lateral') {
      // Cross-step shuffle: push leg sideways, other slightly plants.
      const amp = stride * 0.55 * (lateralSign || 1);
      return [
        { t: 0, e: [8, 0, sign * amp * 0.3] },
        { t: half, e: [12, 0, -sign * amp] },
        { t: duration, e: [8, 0, sign * amp * 0.3] },
      ];
    }
    return [
      { t: 0, e: [sign * s, 0, 0] },
      { t: half, e: [-sign * s, 0, 0] },
      { t: duration, e: [sign * s, 0, 0] },
    ];
  };

  const kneeKeys = (side: 'L' | 'R'): RotKey[] => {
    const bend = Math.abs(stride) * 0.7;
    // Bend peaks mid-swing (opposite contact).
    if (side === 'L') {
      return [
        { t: 0, e: [bend * 0.2, 0, 0] },
        { t: half * 0.5, e: [bend, 0, 0] },
        { t: half, e: [bend * 0.15, 0, 0] },
        { t: half * 1.5, e: [bend * 0.4, 0, 0] },
        { t: duration, e: [bend * 0.2, 0, 0] },
      ];
    }
    return [
      { t: 0, e: [bend * 0.15, 0, 0] },
      { t: half * 0.5, e: [bend * 0.4, 0, 0] },
      { t: half, e: [bend * 0.2, 0, 0] },
      { t: half * 1.5, e: [bend, 0, 0] },
      { t: duration, e: [bend * 0.15, 0, 0] },
    ];
  };

  // Arms oppose legs; hang base + swing about X (sagittal) or slight Y.
  const armKeys = (side: 'L' | 'R'): RotKey[] => {
    const base = side === 'L' ? ARM_DOWN_L : ARM_DOWN_R;
    const sign = side === 'L' ? 1 : -1;
    // Left arm swings with right leg (oppose left leg).
    const swingSign = side === 'L' ? -1 : 1;
    if (legAxis === 'lateral') {
      return [
        { t: 0, e: [base[0] + 8, base[1], base[2] + sign * 6] },
        { t: half, e: [base[0] + 12, base[1], base[2] - sign * 6] },
        { t: duration, e: [base[0] + 8, base[1], base[2] + sign * 6] },
      ];
    }
    return [
      { t: 0, e: [base[0] + swingSign * armSwing * phaseSign, base[1], base[2]] },
      { t: half, e: [base[0] - swingSign * armSwing * phaseSign, base[1], base[2]] },
      { t: duration, e: [base[0] + swingSign * armSwing * phaseSign, base[1], base[2]] },
    ];
  };

  // Small hip yaw for travel direction; torso (spine) stays aimed.
  const hipYaw =
    direction === 'l' ? 12 : direction === 'r' ? -12 : direction === 'b' ? 0 : 0;

  tracks.push(
    rotTrack(n('hips'), [
      { t: 0, e: [lean * 0.3, hipYaw, 0] },
      { t: half, e: [lean * 0.3, hipYaw + counterRot * 0.5 * phaseSign, 0] },
      { t: duration, e: [lean * 0.3, hipYaw, 0] },
    ]),
    posTrack(n('hips'), [
      { t: 0, p: hipsPos(ctx, 0) },
      { t: half * 0.5, p: hipsPos(ctx, hipBob) },
      { t: half, p: hipsPos(ctx, 0) },
      { t: half * 1.5, p: hipsPos(ctx, hipBob) },
      { t: duration, p: hipsPos(ctx, 0) },
    ]),
    rotTrack(n('spine'), [
      { t: 0, e: [lean, -counterRot * 0.4 * phaseSign, 0] },
      { t: half, e: [lean, counterRot * 0.4 * phaseSign, 0] },
      { t: duration, e: [lean, -counterRot * 0.4 * phaseSign, 0] },
    ]),
    rotTrack(n('spine1'), [
      { t: 0, e: [lean * 0.5, -counterRot * 0.3 * phaseSign, 0] },
      { t: half, e: [lean * 0.5, counterRot * 0.3 * phaseSign, 0] },
      { t: duration, e: [lean * 0.5, -counterRot * 0.3 * phaseSign, 0] },
    ]),
    rotTrack(n('leftUpperLeg'), upperLegKeys('L')),
    rotTrack(n('rightUpperLeg'), upperLegKeys('R')),
    rotTrack(n('leftLowerLeg'), kneeKeys('L')),
    rotTrack(n('rightLowerLeg'), kneeKeys('R')),
    rotTrack(n('leftUpperArm'), armKeys('L')),
    rotTrack(n('rightUpperArm'), armKeys('R')),
    // Elbows stay softly bent around the hang baseline while the swing varies.
    rotTrack(n('leftLowerArm'), [
      { t: 0, e: [ELBOW_HANG[0] + 2, 0, 0] },
      { t: half, e: [ELBOW_HANG[0] + 12, 0, 0] },
      { t: duration, e: [ELBOW_HANG[0] + 2, 0, 0] },
    ]),
    rotTrack(n('rightLowerArm'), [
      { t: 0, e: [ELBOW_HANG[0] + 12, 0, 0] },
      { t: half, e: [ELBOW_HANG[0] + 2, 0, 0] },
      { t: duration, e: [ELBOW_HANG[0] + 12, 0, 0] },
    ]),
  );

  return clip(ctx, duration, tracks);
}

function idleClip(ctx: MotionGeneratorContext): THREE.AnimationClip {
  const n = (id: string) => ctx.boneName(id);
  const d = 3.5;
  const tracks: THREE.KeyframeTrack[] = [
    // Breathing sway ±2–3° + slow weight shift.
    rotTrack(n('spine'), [
      { t: 0, e: [2, 0, -2] },
      { t: d * 0.35, e: [-1, 1.5, 2] },
      { t: d * 0.7, e: [2.5, -1, -1.5] },
      { t: d, e: [2, 0, -2] },
    ]),
    rotTrack(n('spine1'), [
      { t: 0, e: [1, 0, 1] },
      { t: d * 0.5, e: [-1.5, 0, -1] },
      { t: d, e: [1, 0, 1] },
    ]),
    rotTrack(n('head'), [
      { t: 0, e: [0, 2, 0] },
      { t: d * 0.5, e: [1, -2, 0] },
      { t: d, e: [0, 2, 0] },
    ]),
    posTrack(n('hips'), [
      { t: 0, p: hipsPos(ctx, 0, 0.01) },
      { t: d * 0.5, p: hipsPos(ctx, -0.012, -0.015) },
      { t: d, p: hipsPos(ctx, 0, 0.01) },
    ]),
    rotTrack(n('leftUpperArm'), [
      { t: 0, e: [ARM_DOWN_L[0] + 2, ARM_DOWN_L[1], ARM_DOWN_L[2] + 1] },
      { t: d * 0.5, e: [ARM_DOWN_L[0] - 2, ARM_DOWN_L[1] + 1, ARM_DOWN_L[2] - 2] },
      { t: d, e: [ARM_DOWN_L[0] + 2, ARM_DOWN_L[1], ARM_DOWN_L[2] + 1] },
    ]),
    rotTrack(n('rightUpperArm'), [
      { t: 0, e: [ARM_DOWN_R[0] - 2, ARM_DOWN_R[1], ARM_DOWN_R[2] - 1] },
      { t: d * 0.5, e: [ARM_DOWN_R[0] + 2, ARM_DOWN_R[1] - 1, ARM_DOWN_R[2] + 2] },
      { t: d, e: [ARM_DOWN_R[0] - 2, ARM_DOWN_R[1], ARM_DOWN_R[2] - 1] },
    ]),
    rotTrack(n('leftLowerArm'), [
      { t: 0, e: ELBOW_HANG },
      { t: d * 0.5, e: [ELBOW_HANG[0] + 3, 0, 0] },
      { t: d, e: ELBOW_HANG },
    ]),
    rotTrack(n('rightLowerArm'), [
      { t: 0, e: ELBOW_HANG },
      { t: d * 0.5, e: [ELBOW_HANG[0] + 3, 0, 0] },
      { t: d, e: ELBOW_HANG },
    ]),
  ];
  return clip(ctx, d, tracks);
}

// ---------------------------------------------------------------------------
// Air
// ---------------------------------------------------------------------------

function jumpClip(ctx: MotionGeneratorContext): THREE.AnimationClip {
  const n = (id: string) => ctx.boneName(id);
  const d = 0.25;
  // Anticipation crouch ~0.1s (hips −0.15 m, knees ~40°), then explosive extension.
  const tracks: THREE.KeyframeTrack[] = [
    posTrack(
      n('hips'),
      [
        { t: 0, p: hipsPos(ctx, 0) },
        { t: 0.1, p: hipsPos(ctx, -0.15) },
        { t: 0.18, p: hipsPos(ctx, 0.04) },
        { t: d, p: hipsPos(ctx, 0.02) },
      ],
      easeOut,
    ),
    rotTrack(
      n('leftUpperLeg'),
      [
        { t: 0, e: ZERO },
        { t: 0.1, e: [-40, 0, 0] },
        { t: 0.2, e: [15, 0, 0] },
        { t: d, e: [10, 0, 0] },
      ],
      easeOut,
    ),
    rotTrack(
      n('rightUpperLeg'),
      [
        { t: 0, e: ZERO },
        { t: 0.1, e: [-40, 0, 0] },
        { t: 0.2, e: [15, 0, 0] },
        { t: d, e: [10, 0, 0] },
      ],
      easeOut,
    ),
    rotTrack(
      n('leftLowerLeg'),
      [
        { t: 0, e: ZERO },
        { t: 0.1, e: [55, 0, 0] },
        { t: 0.2, e: [10, 0, 0] },
        { t: d, e: [15, 0, 0] },
      ],
      easeOut,
    ),
    rotTrack(
      n('rightLowerLeg'),
      [
        { t: 0, e: ZERO },
        { t: 0.1, e: [55, 0, 0] },
        { t: 0.2, e: [10, 0, 0] },
        { t: d, e: [15, 0, 0] },
      ],
      easeOut,
    ),
    rotTrack(
      n('spine'),
      [
        { t: 0, e: [5, 0, 0] },
        { t: 0.1, e: [18, 0, 0] },
        { t: 0.2, e: [-8, 0, 0] },
        { t: d, e: [-5, 0, 0] },
      ],
      easeOut,
    ),
    // Arms drive upward out of hang.
    rotTrack(
      n('leftUpperArm'),
      [
        { t: 0, e: ARM_DOWN_L },
        { t: 0.1, e: [ARM_DOWN_L[0] + 20, 0, ARM_DOWN_L[2] + 15] },
        { t: d, e: [-40, 0, -50] },
      ],
      easeIn,
    ),
    rotTrack(
      n('rightUpperArm'),
      [
        { t: 0, e: ARM_DOWN_R },
        { t: 0.1, e: [ARM_DOWN_R[0] + 20, 0, ARM_DOWN_R[2] - 15] },
        { t: d, e: [-40, 0, 50] },
      ],
      easeIn,
    ),
  ];
  return clip(ctx, d, tracks);
}

function fallClip(ctx: MotionGeneratorContext): THREE.AnimationClip {
  const n = (id: string) => ctx.boneName(id);
  const d = 0.8;
  // Legs tucked, arms out for balance, ±2–3° sway.
  return clip(ctx, d, [
    rotTrack(n('spine'), [
      { t: 0, e: [8, 0, -2] },
      { t: d * 0.5, e: [6, 0, 2.5] },
      { t: d, e: [8, 0, -2] },
    ]),
    rotTrack(n('leftUpperLeg'), [
      { t: 0, e: [-25, 8, 0] },
      { t: d * 0.5, e: [-22, 5, 0] },
      { t: d, e: [-25, 8, 0] },
    ]),
    rotTrack(n('rightUpperLeg'), [
      { t: 0, e: [-22, -5, 0] },
      { t: d * 0.5, e: [-26, -8, 0] },
      { t: d, e: [-22, -5, 0] },
    ]),
    rotTrack(n('leftLowerLeg'), [
      { t: 0, e: [40, 0, 0] },
      { t: d, e: [40, 0, 0] },
    ]),
    rotTrack(n('rightLowerLeg'), [
      { t: 0, e: [45, 0, 0] },
      { t: d, e: [45, 0, 0] },
    ]),
    rotTrack(n('leftUpperArm'), [
      { t: 0, e: [0, 0, -55] },
      { t: d * 0.5, e: [5, 0, -50] },
      { t: d, e: [0, 0, -55] },
    ]),
    rotTrack(n('rightUpperArm'), [
      { t: 0, e: [0, 0, 55] },
      { t: d * 0.5, e: [5, 0, 50] },
      { t: d, e: [0, 0, 55] },
    ]),
    rotTrack(n('leftLowerArm'), [
      { t: 0, e: [ELBOW_HANG[0] + 8, 0, 0] },
      { t: d, e: [ELBOW_HANG[0] + 8, 0, 0] },
    ]),
    rotTrack(n('rightLowerArm'), [
      { t: 0, e: [ELBOW_HANG[0] + 8, 0, 0] },
      { t: d, e: [ELBOW_HANG[0] + 8, 0, 0] },
    ]),
  ]);
}

function landClip(ctx: MotionGeneratorContext): THREE.AnimationClip {
  const n = (id: string) => ctx.boneName(id);
  const d = 0.3;
  return clip(ctx, d, [
    posTrack(
      n('hips'),
      [
        { t: 0, p: hipsPos(ctx, 0.02) },
        { t: 0.1, p: hipsPos(ctx, -0.12) },
        { t: d, p: hipsPos(ctx, 0) },
      ],
      easeOut,
    ),
    rotTrack(
      n('leftUpperLeg'),
      [
        { t: 0, e: [10, 0, 0] },
        { t: 0.1, e: [-35, 0, 0] },
        { t: d, e: ZERO },
      ],
      easeOut,
    ),
    rotTrack(
      n('rightUpperLeg'),
      [
        { t: 0, e: [10, 0, 0] },
        { t: 0.1, e: [-35, 0, 0] },
        { t: d, e: ZERO },
      ],
      easeOut,
    ),
    rotTrack(
      n('leftLowerLeg'),
      [
        { t: 0, e: [15, 0, 0] },
        { t: 0.1, e: [50, 0, 0] },
        { t: d, e: ZERO },
      ],
      easeOut,
    ),
    rotTrack(
      n('rightLowerLeg'),
      [
        { t: 0, e: [15, 0, 0] },
        { t: 0.1, e: [50, 0, 0] },
        { t: d, e: ZERO },
      ],
      easeOut,
    ),
    rotTrack(
      n('spine'),
      [
        { t: 0, e: [-5, 0, 0] },
        { t: 0.1, e: [20, 0, 0] },
        { t: d, e: ZERO },
      ],
      easeOut,
    ),
    rotTrack(
      n('leftUpperArm'),
      [
        { t: 0, e: [-30, 0, -45] },
        { t: 0.12, e: [ARM_DOWN_L[0] + 15, 0, ARM_DOWN_L[2] + 10] },
        { t: d, e: ARM_DOWN_L },
      ],
      easeOut,
    ),
    rotTrack(
      n('rightUpperArm'),
      [
        { t: 0, e: [-30, 0, 45] },
        { t: 0.12, e: [ARM_DOWN_R[0] + 15, 0, ARM_DOWN_R[2] - 10] },
        { t: d, e: ARM_DOWN_R },
      ],
      easeOut,
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Abilities
// ---------------------------------------------------------------------------

function actHurl1h(ctx: MotionGeneratorContext): THREE.AnimationClip {
  const n = (id: string) => ctx.boneName(id);
  const d = 0.9;
  // Windup 0→0.35 gather; release ~0.4 snap thrust; recover 0.5→0.9.
  // Dominant axis: forward (sagittal). Counter-rotation ≥20°.
  return clip(ctx, d, [
    posTrack(
      n('hips'),
      [
        { t: 0, p: hipsPos(ctx, 0) },
        { t: 0.3, p: hipsPos(ctx, -0.04, 0, -0.02) },
        { t: 0.42, p: hipsPos(ctx, 0.01, 0, 0.03) },
        { t: d, p: hipsPos(ctx, 0) },
      ],
      easeOut,
    ),
    // Spine twists away during windup, unwinds on release.
    rotTrack(
      n('spine'),
      [
        { t: 0, e: ZERO },
        { t: 0.32, e: [5, -35, -5] },
        { t: 0.42, e: [-5, 20, 5] },
        { t: d, e: ZERO },
      ],
      easeOut,
    ),
    rotTrack(
      n('spine1'),
      [
        { t: 0, e: ZERO },
        { t: 0.32, e: [0, -20, 0] },
        { t: 0.42, e: [0, 15, 0] },
        { t: d, e: ZERO },
      ],
      easeOut,
    ),
    // Casting (right) hand: pull back past shoulder, snap to full extension.
    rotTrack(
      n('rightUpperArm'),
      [
        { t: 0, e: ARM_DOWN_R },
        { t: 0.15, e: [-30, -40, 70] },
        { t: 0.35, e: [-50, -70, 40] },
        { t: 0.42, e: [-10, 10, 100] },
        { t: d, e: ARM_DOWN_R },
      ],
      // Slow into windup peak, then linear-ish for snap segment (handled by key spacing).
      easeOut,
    ),
    rotTrack(
      n('rightLowerArm'),
      [
        { t: 0, e: ELBOW_HANG },
        { t: 0.35, e: [90, -20, 0] },
        { t: 0.42, e: [5, 0, 0] },
        { t: d, e: ELBOW_HANG },
      ],
      easeIn,
    ),
    rotTrack(
      n('rightHand'),
      [
        { t: 0, e: ZERO },
        { t: 0.35, e: [0, 0, -20] },
        { t: 0.42, e: [0, 0, 10] },
        { t: d, e: ZERO },
      ],
      easeIn,
    ),
    // Off-hand guards forward.
    rotTrack(
      n('leftUpperArm'),
      [
        { t: 0, e: ARM_DOWN_L },
        { t: 0.3, e: [-20, 30, -70] },
        { t: 0.45, e: [-15, 20, -65] },
        { t: d, e: ARM_DOWN_L },
      ],
      easeOut,
    ),
    rotTrack(
      n('leftLowerArm'),
      [
        { t: 0, e: ELBOW_HANG },
        { t: 0.3, e: [50, 0, 0] },
        { t: d, e: ELBOW_HANG },
      ],
      easeOut,
    ),
    rotTrack(
      n('head'),
      [
        { t: 0, e: ZERO },
        { t: 0.35, e: [0, -15, 0] },
        { t: 0.42, e: [0, 10, 0] },
        { t: d, e: ZERO },
      ],
      easeOut,
    ),
  ]);
}

function actSlam2h(ctx: MotionGeneratorContext): THREE.AnimationClip {
  const n = (id: string) => ctx.boneName(id);
  const d = 1.0;
  // Overhead two-hand gather, slam down through the front. Vertical dominant axis.
  return clip(ctx, d, [
    posTrack(
      n('hips'),
      [
        { t: 0, p: hipsPos(ctx, 0) },
        { t: 0.35, p: hipsPos(ctx, -0.06) },
        { t: 0.5, p: hipsPos(ctx, -0.1) },
        { t: d, p: hipsPos(ctx, 0) },
      ],
      easeOut,
    ),
    rotTrack(
      n('spine'),
      [
        { t: 0, e: ZERO },
        { t: 0.35, e: [-25, 0, 0] },
        { t: 0.5, e: [35, 0, 0] },
        { t: d, e: ZERO },
      ],
      easeOut,
    ),
    rotTrack(
      n('spine1'),
      [
        { t: 0, e: ZERO },
        { t: 0.35, e: [-20, 0, 0] },
        { t: 0.5, e: [25, 0, 0] },
        { t: d, e: ZERO },
      ],
      easeOut,
    ),
    rotTrack(
      n('leftUpperArm'),
      [
        { t: 0, e: ARM_DOWN_L },
        { t: 0.35, e: [-140, 20, -40] },
        { t: 0.5, e: [-20, 10, -50] },
        { t: d, e: ARM_DOWN_L },
      ],
      easeOut,
    ),
    rotTrack(
      n('rightUpperArm'),
      [
        { t: 0, e: ARM_DOWN_R },
        { t: 0.35, e: [-140, -20, 40] },
        { t: 0.5, e: [-20, -10, 50] },
        { t: d, e: ARM_DOWN_R },
      ],
      easeOut,
    ),
    rotTrack(
      n('leftLowerArm'),
      [
        { t: 0, e: ELBOW_HANG },
        { t: 0.35, e: [40, 0, 0] },
        { t: 0.5, e: [10, 0, 0] },
        { t: d, e: ELBOW_HANG },
      ],
      easeIn,
    ),
    rotTrack(
      n('rightLowerArm'),
      [
        { t: 0, e: ELBOW_HANG },
        { t: 0.35, e: [40, 0, 0] },
        { t: 0.5, e: [10, 0, 0] },
        { t: d, e: ELBOW_HANG },
      ],
      easeIn,
    ),
    rotTrack(
      n('leftUpperLeg'),
      [
        { t: 0, e: ZERO },
        { t: 0.5, e: [-15, 0, 0] },
        { t: d, e: ZERO },
      ],
      easeOut,
    ),
    rotTrack(
      n('rightUpperLeg'),
      [
        { t: 0, e: ZERO },
        { t: 0.5, e: [-15, 0, 0] },
        { t: d, e: ZERO },
      ],
      easeOut,
    ),
  ]);
}

function actSwing1h(ctx: MotionGeneratorContext): THREE.AnimationClip {
  const n = (id: string) => ctx.boneName(id);
  const d = 0.9;
  // Lateral arc. Windup 0→0.35, strike 0.35→0.45 contact center, recover.
  // Shoulder/hip counter-twist ≥45° / ≥20°.
  return clip(ctx, d, [
    posTrack(
      n('hips'),
      [
        { t: 0, p: hipsPos(ctx, 0) },
        { t: 0.3, p: hipsPos(ctx, -0.03, 0.02) },
        { t: 0.45, p: hipsPos(ctx, 0.01, -0.03) },
        { t: d, p: hipsPos(ctx, 0) },
      ],
      easeOut,
    ),
    rotTrack(
      n('hips'),
      [
        { t: 0, e: ZERO },
        { t: 0.32, e: [0, 20, 0] },
        { t: 0.45, e: [0, -25, 0] },
        { t: d, e: ZERO },
      ],
      easeOut,
    ),
    rotTrack(
      n('spine'),
      [
        { t: 0, e: ZERO },
        { t: 0.32, e: [5, 45, 10] },
        { t: 0.45, e: [8, -40, -8] },
        { t: d, e: ZERO },
      ],
      easeOut,
    ),
    rotTrack(
      n('spine1'),
      [
        { t: 0, e: ZERO },
        { t: 0.32, e: [0, 25, 5] },
        { t: 0.45, e: [0, -30, -5] },
        { t: d, e: ZERO },
      ],
      easeOut,
    ),
    // Weapon hand cocks up-and-across, then horizontal descending arc.
    rotTrack(
      n('rightUpperArm'),
      [
        { t: 0, e: ARM_DOWN_R },
        { t: 0.2, e: [-80, 50, 50] },
        { t: 0.35, e: [-90, 70, 30] },
        { t: 0.45, e: [-40, -60, 70] },
        { t: 0.6, e: [10, -80, 60] },
        { t: d, e: ARM_DOWN_R },
      ],
      easeOut,
    ),
    rotTrack(
      n('rightLowerArm'),
      [
        { t: 0, e: ELBOW_HANG },
        { t: 0.35, e: [30, 0, 20] },
        { t: 0.45, e: [20, 0, -10] },
        { t: d, e: ELBOW_HANG },
      ],
      easeIn,
    ),
    rotTrack(
      n('leftUpperArm'),
      [
        { t: 0, e: ARM_DOWN_L },
        { t: 0.35, e: [ARM_DOWN_L[0] + 15, ARM_DOWN_L[1] + 20, ARM_DOWN_L[2] + 15] },
        { t: 0.5, e: [ARM_DOWN_L[0] + 10, ARM_DOWN_L[1] - 10, ARM_DOWN_L[2]] },
        { t: d, e: ARM_DOWN_L },
      ],
      easeOut,
    ),
    rotTrack(
      n('head'),
      [
        { t: 0, e: ZERO },
        { t: 0.35, e: [0, 20, 0] },
        { t: 0.45, e: [0, -15, 0] },
        { t: d, e: ZERO },
      ],
      easeOut,
    ),
  ]);
}

function actGuardHold(ctx: MotionGeneratorContext): THREE.AnimationClip {
  const n = (id: string) => ctx.boneName(id);
  // Enter ~0.12s snap, then held loop with micro-sway. Clip loops cleanly.
  const d = 1.2;
  const guardSpine: EulerXYZ = [8, 0, 0];
  const guardR: EulerXYZ = [-50, -30, 75];
  const guardL: EulerXYZ = [-45, 35, -70];
  return clip(ctx, d, [
    posTrack(n('hips'), [
      { t: 0, p: hipsPos(ctx, 0) },
      { t: 0.1, p: hipsPos(ctx, -0.04) },
      { t: d * 0.5, p: hipsPos(ctx, -0.035) },
      { t: d, p: hipsPos(ctx, -0.04) },
    ]),
    rotTrack(
      n('spine'),
      [
        { t: 0, e: ZERO },
        { t: 0.1, e: guardSpine },
        { t: d * 0.5, e: [guardSpine[0] + 2, 1.5, -2] },
        { t: d, e: guardSpine },
      ],
      easeIn,
    ),
    rotTrack(
      n('rightUpperArm'),
      [
        { t: 0, e: ARM_DOWN_R },
        { t: 0.1, e: guardR },
        { t: d * 0.5, e: [guardR[0] + 3, guardR[1], guardR[2] + 2] },
        { t: d, e: guardR },
      ],
      easeIn,
    ),
    rotTrack(
      n('leftUpperArm'),
      [
        { t: 0, e: ARM_DOWN_L },
        { t: 0.1, e: guardL },
        { t: d * 0.5, e: [guardL[0] + 2, guardL[1], guardL[2] - 2] },
        { t: d, e: guardL },
      ],
      easeIn,
    ),
    rotTrack(n('rightLowerArm'), [
      { t: 0, e: ELBOW_HANG },
      { t: 0.1, e: [70, 0, 0] },
      { t: d, e: [70, 0, 0] },
    ]),
    rotTrack(n('leftLowerArm'), [
      { t: 0, e: ELBOW_HANG },
      { t: 0.1, e: [65, 0, 0] },
      { t: d, e: [65, 0, 0] },
    ]),
    rotTrack(n('head'), [
      { t: 0, e: ZERO },
      { t: 0.1, e: [5, 0, 0] },
      { t: d * 0.5, e: [4, 2, 0] },
      { t: d, e: [5, 0, 0] },
    ]),
  ]);
}

function actDrink(ctx: MotionGeneratorContext): THREE.AnimationClip {
  const n = (id: string) => ctx.boneName(id);
  const d = 1.4;
  // Raise to head, head tilts back, hold ~0.5s, lower. Slow / vulnerable read.
  return clip(ctx, d, [
    rotTrack(
      n('rightUpperArm'),
      [
        { t: 0, e: ARM_DOWN_R },
        { t: 0.35, e: [-100, -20, 50] },
        { t: 0.5, e: [-120, -10, 40] },
        { t: 1.0, e: [-120, -10, 40] },
        { t: d, e: ARM_DOWN_R },
      ],
      easeInOut,
    ),
    rotTrack(
      n('rightLowerArm'),
      [
        { t: 0, e: ELBOW_HANG },
        { t: 0.4, e: [80, 0, 0] },
        { t: 1.0, e: [85, 0, 0] },
        { t: d, e: ELBOW_HANG },
      ],
      easeInOut,
    ),
    rotTrack(
      n('rightHand'),
      [
        { t: 0, e: ZERO },
        { t: 0.5, e: [20, 0, -30] },
        { t: 1.0, e: [20, 0, -30] },
        { t: d, e: ZERO },
      ],
      easeInOut,
    ),
    rotTrack(
      n('head'),
      [
        { t: 0, e: ZERO },
        { t: 0.45, e: [-25, 5, 0] },
        { t: 1.0, e: [-30, 5, 0] },
        { t: d, e: ZERO },
      ],
      easeInOut,
    ),
    rotTrack(
      n('spine'),
      [
        { t: 0, e: ZERO },
        { t: 0.5, e: [-5, 8, 0] },
        { t: 1.0, e: [-5, 8, 0] },
        { t: d, e: ZERO },
      ],
      easeInOut,
    ),
    rotTrack(
      n('leftUpperArm'),
      [
        { t: 0, e: ARM_DOWN_L },
        { t: 0.5, e: [ARM_DOWN_L[0] + 5, 0, ARM_DOWN_L[2]] },
        { t: d, e: ARM_DOWN_L },
      ],
      easeInOut,
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

function reactHit(ctx: MotionGeneratorContext): THREE.AnimationClip {
  const n = (id: string) => ctx.boneName(id);
  const d = 0.35;
  // Sharp 10–15° flinch within ~2–3 frames, ease back.
  return clip(ctx, d, [
    rotTrack(
      n('spine'),
      [
        { t: 0, e: ZERO },
        { t: 0.04, e: [-15, 12, 8] },
        { t: d, e: ZERO },
      ],
      easeOut,
    ),
    rotTrack(
      n('spine1'),
      [
        { t: 0, e: ZERO },
        { t: 0.04, e: [-10, 8, 5] },
        { t: d, e: ZERO },
      ],
      easeOut,
    ),
    rotTrack(
      n('head'),
      [
        { t: 0, e: ZERO },
        { t: 0.05, e: [-12, 10, 0] },
        { t: d, e: ZERO },
      ],
      easeOut,
    ),
    rotTrack(
      n('leftUpperArm'),
      [
        { t: 0, e: ARM_DOWN_L },
        { t: 0.05, e: [ARM_DOWN_L[0] - 15, 0, ARM_DOWN_L[2] - 20] },
        { t: d, e: ARM_DOWN_L },
      ],
      easeOut,
    ),
    rotTrack(
      n('rightUpperArm'),
      [
        { t: 0, e: ARM_DOWN_R },
        { t: 0.05, e: [ARM_DOWN_R[0] - 15, 0, ARM_DOWN_R[2] + 20] },
        { t: d, e: ARM_DOWN_R },
      ],
      easeOut,
    ),
  ]);
}

function reactDeath(ctx: MotionGeneratorContext): THREE.AnimationClip {
  const n = (id: string) => ctx.boneName(id);
  const d = 1.5;
  // Impact → knees buckle → fall. Final pose fully down.
  return clip(ctx, d, [
    posTrack(
      n('hips'),
      [
        { t: 0, p: hipsPos(ctx, 0) },
        { t: 0.2, p: hipsPos(ctx, -0.08, 0, -0.05) },
        { t: 0.6, p: hipsPos(ctx, -0.45, 0.05, -0.15) },
        { t: 1.0, p: hipsPos(ctx, -0.85, 0.1, -0.2) },
        { t: d, p: hipsPos(ctx, -0.95, 0.12, -0.22) },
      ],
      easeInOut,
    ),
    rotTrack(
      n('hips'),
      [
        { t: 0, e: ZERO },
        { t: 0.2, e: [-15, 20, 10] },
        { t: 0.7, e: [-55, 40, 25] },
        { t: d, e: [-90, 30, 15] },
      ],
      easeInOut,
    ),
    rotTrack(
      n('spine'),
      [
        { t: 0, e: ZERO },
        { t: 0.15, e: [-20, 15, 0] },
        { t: 0.8, e: [30, 10, 15] },
        { t: d, e: [20, 5, 10] },
      ],
      easeInOut,
    ),
    rotTrack(
      n('leftUpperLeg'),
      [
        { t: 0, e: ZERO },
        { t: 0.35, e: [-50, 15, 0] },
        { t: d, e: [-20, 25, 10] },
      ],
      easeInOut,
    ),
    rotTrack(
      n('rightUpperLeg'),
      [
        { t: 0, e: ZERO },
        { t: 0.4, e: [-40, -20, 0] },
        { t: d, e: [10, -30, -15] },
      ],
      easeInOut,
    ),
    rotTrack(
      n('leftLowerLeg'),
      [
        { t: 0, e: ZERO },
        { t: 0.4, e: [70, 0, 0] },
        { t: d, e: [30, 0, 0] },
      ],
      easeInOut,
    ),
    rotTrack(
      n('rightLowerLeg'),
      [
        { t: 0, e: ZERO },
        { t: 0.45, e: [60, 0, 0] },
        { t: d, e: [25, 0, 0] },
      ],
      easeInOut,
    ),
    rotTrack(
      n('leftUpperArm'),
      [
        { t: 0, e: ARM_DOWN_L },
        { t: 0.3, e: [-40, 30, -40] },
        { t: d, e: [30, 40, -20] },
      ],
      easeInOut,
    ),
    rotTrack(
      n('rightUpperArm'),
      [
        { t: 0, e: ARM_DOWN_R },
        { t: 0.25, e: [-50, -40, 50] },
        { t: d, e: [20, -50, 30] },
      ],
      easeInOut,
    ),
    rotTrack(
      n('head'),
      [
        { t: 0, e: ZERO },
        { t: 0.3, e: [-20, 30, 0] },
        { t: d, e: [15, 20, 10] },
      ],
      easeInOut,
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Stances — upper band only (Spine2..Head, shoulders/arms/hands).
// Hips / Spine / Spine1 and legs are locomotion's; tracks there would be
// masked out and must not fight walk counter-rotation.
// ---------------------------------------------------------------------------

/**
 * Walking-staff carry in the right hand. Right arm hangs with a soft elbow so
 * the grip sits near hip height; left arm relaxed; slight head tilt and a
 * raised right shoulder read the weight of the shaft.
 */
function stanceStaff(ctx: MotionGeneratorContext): THREE.AnimationClip {
  const n = (id: string) => ctx.boneName(id);
  const d = 3.0;
  // Right: hang + a touch more elbow, hand closed on the shaft.
  const staffR: EulerXYZ = [8, -6, 78];
  const staffElbowR: EulerXYZ = [28, 0, 0];
  // Left: hang, a hair more open so it does not mirror the loaded side.
  const staffL: EulerXYZ = [6, 4, -82];
  const staffElbowL: EulerXYZ = [16, 0, 0];
  // Spine2 only — slight settle, not a gait lean.
  const chest: EulerXYZ = [3, 0, 0];
  const headTilt: EulerXYZ = [6, 0, 0];

  return clip(ctx, d, [
    rotTrack(n('spine2'), [
      { t: 0, e: chest },
      { t: d * 0.4, e: [chest[0] + 1.5, 1, -1] },
      { t: d * 0.75, e: [chest[0] - 0.5, -1, 1] },
      { t: d, e: chest },
    ]),
    // Loaded right shoulder rides a few degrees higher than the left.
    rotTrack(n('rightShoulder'), [
      { t: 0, e: [0, 0, 6] },
      { t: d * 0.5, e: [1, 0, 7] },
      { t: d, e: [0, 0, 6] },
    ]),
    rotTrack(n('leftShoulder'), [
      { t: 0, e: [0, 0, -2] },
      { t: d * 0.5, e: [0, 0, -1] },
      { t: d, e: [0, 0, -2] },
    ]),
    rotTrack(n('rightUpperArm'), [
      { t: 0, e: staffR },
      { t: d * 0.45, e: [staffR[0] + 2, staffR[1] - 1, staffR[2] + 1] },
      { t: d, e: staffR },
    ]),
    rotTrack(n('leftUpperArm'), [
      { t: 0, e: staffL },
      { t: d * 0.55, e: [staffL[0] - 2, staffL[1] + 1, staffL[2] - 1] },
      { t: d, e: staffL },
    ]),
    rotTrack(n('rightLowerArm'), [
      { t: 0, e: staffElbowR },
      { t: d * 0.5, e: [staffElbowR[0] + 3, 0, 0] },
      { t: d, e: staffElbowR },
    ]),
    rotTrack(n('leftLowerArm'), [
      { t: 0, e: staffElbowL },
      { t: d * 0.5, e: [staffElbowL[0] + 2, 0, 0] },
      { t: d, e: staffElbowL },
    ]),
    // Closed fist around the shaft — small Z curl, no flourish.
    rotTrack(n('rightHand'), [
      { t: 0, e: [8, 0, -12] },
      { t: d * 0.5, e: [10, 0, -10] },
      { t: d, e: [8, 0, -12] },
    ]),
    rotTrack(n('leftHand'), [
      { t: 0, e: ZERO },
      { t: d * 0.5, e: [2, 0, 0] },
      { t: d, e: ZERO },
    ]),
    rotTrack(n('head'), [
      { t: 0, e: headTilt },
      { t: d * 0.5, e: [headTilt[0] + 1, 2, 0] },
      { t: d, e: headTilt },
    ]),
    rotTrack(n('neck'), [
      { t: 0, e: [2, 0, 0] },
      { t: d * 0.5, e: [3, 0, 0] },
      { t: d, e: [2, 0, 0] },
    ]),
  ]);
}

/**
 * Sword-and-shield ready: shield up-and-across on the left, sword arm down and
 * back on the right with the blade angled out. Shield-side leads via Spine2 —
 * mid-spine is locomotion's and must stay free.
 */
function stanceSwordShield(ctx: MotionGeneratorContext): THREE.AnimationClip {
  const n = (id: string) => ctx.boneName(id);
  const d = 2.8;
  // Shield leads: small yaw so the left side is forward of the right.
  const chest: EulerXYZ = [4, 10, -3];
  // Left arm: haul the upper arm up-and-in so the hand sits at mid-chest,
  // left-of-centre and a little forward — not down at the hip. Elbow bent ~90°
  // so the forearm presents across the torso; the shield strap (identity grip)
  // then rides that presentation with its boss facing the threat.
  const shieldArm: EulerXYZ = [-80, 45, -80];
  const shieldElbow: EulerXYZ = [90, 20, 0];
  // Right arm: down and slightly back, elbow ~40°, hand opens the blade up/out.
  const swordArm: EulerXYZ = [18, -22, 72];
  const swordElbow: EulerXYZ = [40, 0, -8];
  const headReady: EulerXYZ = [2, -6, 0];

  return clip(ctx, d, [
    rotTrack(n('spine2'), [
      { t: 0, e: chest },
      { t: d * 0.4, e: [chest[0] + 1.5, chest[1] + 1, chest[2] - 1] },
      { t: d * 0.7, e: [chest[0] - 0.5, chest[1] - 1, chest[2] + 1] },
      { t: d, e: chest },
    ]),
    rotTrack(n('leftShoulder'), [
      { t: 0, e: [6, 10, -12] },
      { t: d * 0.5, e: [7, 10, -13] },
      { t: d, e: [6, 10, -12] },
    ]),
    rotTrack(n('rightShoulder'), [
      { t: 0, e: [0, -4, 4] },
      { t: d * 0.5, e: [1, -4, 5] },
      { t: d, e: [0, -4, 4] },
    ]),
    rotTrack(n('leftUpperArm'), [
      { t: 0, e: shieldArm },
      { t: d * 0.45, e: [shieldArm[0] + 2, shieldArm[1] + 1, shieldArm[2] - 1] },
      { t: d, e: shieldArm },
    ]),
    rotTrack(n('rightUpperArm'), [
      { t: 0, e: swordArm },
      { t: d * 0.55, e: [swordArm[0] + 2, swordArm[1] - 1, swordArm[2] + 1] },
      { t: d, e: swordArm },
    ]),
    rotTrack(n('leftLowerArm'), [
      { t: 0, e: shieldElbow },
      { t: d * 0.5, e: [shieldElbow[0] + 3, shieldElbow[1], 0] },
      { t: d, e: shieldElbow },
    ]),
    rotTrack(n('rightLowerArm'), [
      { t: 0, e: swordElbow },
      { t: d * 0.5, e: [swordElbow[0] + 3, 0, swordElbow[2]] },
      { t: d, e: swordElbow },
    ]),
    // Flat of the blade out; slight wrist so the point does not cross the shield.
    rotTrack(n('rightHand'), [
      { t: 0, e: [12, -18, -15] },
      { t: d * 0.5, e: [14, -16, -14] },
      { t: d, e: [12, -18, -15] },
    ]),
    // Forearm strap seat — hand stays quiet; the elbow carries the pose.
    rotTrack(n('leftHand'), [
      { t: 0, e: [5, 8, 6] },
      { t: d * 0.5, e: [6, 8, 7] },
      { t: d, e: [5, 8, 6] },
    ]),
    rotTrack(n('head'), [
      { t: 0, e: headReady },
      { t: d * 0.5, e: [headReady[0] + 1, headReady[1] + 2, 0] },
      { t: d, e: headReady },
    ]),
    rotTrack(n('neck'), [
      { t: 0, e: [1, -2, 0] },
      { t: d * 0.5, e: [2, -2, 0] },
      { t: d, e: [1, -2, 0] },
    ]),
  ]);
}

// ---------------------------------------------------------------------------
// Registration — generator id IS the content key
// ---------------------------------------------------------------------------

registerMotionGenerator(MOTION_LOCOMOTION.idle, idleClip);

registerMotionGenerator(MOTION_LOCOMOTION.walkForward, ctx =>
  gaitClip(ctx, {
    duration: 1.0,
    stride: 28,
    armSwing: 45,
    lean: 4,
    hipBob: 0.02,
    counterRot: 15,
    direction: 'f',
  }),
);
registerMotionGenerator(MOTION_LOCOMOTION.walkBack, ctx =>
  gaitClip(ctx, {
    duration: 1.0,
    stride: 28,
    armSwing: 35,
    lean: 2,
    hipBob: 0.015,
    counterRot: 12,
    direction: 'b',
  }),
);
registerMotionGenerator(MOTION_LOCOMOTION.walkLeft, ctx =>
  gaitClip(ctx, {
    duration: 1.0,
    stride: 24,
    armSwing: 30,
    lean: 3,
    hipBob: 0.018,
    counterRot: 10,
    direction: 'l',
  }),
);
registerMotionGenerator(MOTION_LOCOMOTION.walkRight, ctx =>
  gaitClip(ctx, {
    duration: 1.0,
    stride: 24,
    armSwing: 30,
    lean: 3,
    hipBob: 0.018,
    counterRot: 10,
    direction: 'r',
  }),
);

registerMotionGenerator(MOTION_LOCOMOTION.runForward, ctx =>
  gaitClip(ctx, {
    duration: 0.65,
    stride: 42,
    armSwing: 70,
    lean: 14,
    hipBob: 0.045,
    counterRot: 22,
    direction: 'f',
  }),
);
registerMotionGenerator(MOTION_LOCOMOTION.runBack, ctx =>
  gaitClip(ctx, {
    duration: 0.65,
    stride: 42,
    armSwing: 55,
    lean: 8,
    hipBob: 0.035,
    counterRot: 18,
    direction: 'b',
  }),
);
registerMotionGenerator(MOTION_LOCOMOTION.runLeft, ctx =>
  gaitClip(ctx, {
    duration: 0.65,
    stride: 36,
    armSwing: 50,
    lean: 10,
    hipBob: 0.04,
    counterRot: 16,
    direction: 'l',
  }),
);
registerMotionGenerator(MOTION_LOCOMOTION.runRight, ctx =>
  gaitClip(ctx, {
    duration: 0.65,
    stride: 36,
    armSwing: 50,
    lean: 10,
    hipBob: 0.04,
    counterRot: 16,
    direction: 'r',
  }),
);

registerMotionGenerator(MOTION_AIR.jump, jumpClip);
registerMotionGenerator(MOTION_AIR.fall, fallClip);
registerMotionGenerator(MOTION_AIR.land, landClip);

registerMotionGenerator(MOTION_ACTION.hurl1h, actHurl1h);
registerMotionGenerator(MOTION_ACTION.slam2h, actSlam2h);
registerMotionGenerator(MOTION_ACTION.swing1h, actSwing1h);
registerMotionGenerator(MOTION_ACTION.guardHold, actGuardHold);
registerMotionGenerator(MOTION_ACTION.drink, actDrink);

registerMotionGenerator(MOTION_STANCE.staff, stanceStaff);
registerMotionGenerator(MOTION_STANCE.swordShield, stanceSwordShield);

registerMotionGenerator(MOTION_REACTION.hit, reactHit);
registerMotionGenerator(MOTION_REACTION.death, reactDeath);
