import * as THREE from 'three';
import {
  DEFAULT_GUARD_MOTIONS,
  DEFAULT_REACTION_MOTIONS,
  MOTION_RULES,
  type MotionRule,
  type MotionRuleName,
} from './config';
import {
  ALL_BANDS,
  freezeClipAt,
  maskClipToBands,
  maskClipToOverlay,
  OVERLAY_BANDS,
  UPPER_BANDS,
  type AnimationBand,
  type OverlayWidth,
} from './mask';

export type MotionResolver = (key: string) => THREE.AnimationClip | null;

/**
 * One clip supplying one part of a held pose.
 *
 * Structurally what `content/stances.ts` calls a `StancePose`, restated here so
 * the controller keeps knowing nothing about the content vocabulary, and so the
 * dependency runs one way — stances already import the band names.
 */
export type StancePart = {
  motion: string;
  bands: readonly AnimationBand[];
  /**
   * Hold one moment of the clip instead of playing it.
   *
   * A stance wants a looping pose and the library ships few, but several clips
   * pass through one. `'end'` takes the last frame — a recovery that finishes
   * with the hands up is a guard, whatever it is called. See `freezeClipAt`.
   */
  hold?: number | 'end';
};

export type AbilityPlaybackOptions = {
  /**
   * Mirrors ClipSource.upperBodyOnly. False selects the full-body override layer.
   */
  upperBodyOnly?: boolean;
  /**
   * Fraction of normal move speed this action permits, 0 (rooted) to 1 (free).
   *
   * This is one number with two jobs, deliberately: gameplay scales the move
   * speed by it, and the controller narrows the mask when it is above zero. A
   * rooted action owns the whole torso because nothing else needs it; an action
   * you can walk through leaves the lower spine to the walk. They cannot drift
   * apart, because there is only the one value.
   *
   * Defaults to 0 — an action roots you unless it says otherwise.
   */
  movement?: number;
};

/**
 * The three keys a phased motion may bind. `held` is the only required one —
 * see `playPhased`.
 */
export type PhasedKeys = {
  /** One-shot transition into the held pose. Optional; held starts directly without it. */
  enter?: string;
  /** The looping (or static) pose held for as long as the phase is desired. */
  held: string;
  /** One-shot transition out. Optional; release fades directly without it. */
  exit?: string;
};

/**
 * Which `MOTION_RULES` entry governs each phase's blend/priority/interruption.
 * Phased motions stay data-driven the same way every other motion here does;
 * `playPhased` has no opinion of its own about timing.
 */
export type PhasedRuleNames = {
  enter: MotionRuleName;
  held: MotionRuleName;
  exit: MotionRuleName;
};

/**
 * An ordered attack run, as data. See `startChain`/`advanceChain`.
 */
export type ChainSpec = {
  /** Motion keys in order. `steps[0]` is the opener, played by `startChain`. */
  steps: readonly string[];
  /**
   * Inclusive fraction (0..1) of the CURRENTLY PLAYING step's own clip duration
   * during which `advanceChain` crossfades into the next step.
   */
  cancelWindow: { fromFraction: number; toFraction: number };
  /**
   * What `advanceChain` does when the request lands outside the window.
   * `'ignore'` (default) drops it. `'queue'` remembers it and fires the next
   * step automatically once playback reaches the window.
   */
  outsideWindow?: 'queue' | 'ignore';
};

export type ChainAdvanceResult = 'advanced' | 'queued' | 'ignored' | 'inactive';

/**
 * Motion ids are caller-defined strings — the exported defaults are only a
 * fallback. Typing these as the defaults' literal types would allow callers to
 * pass nothing but those same literals, making the options unusable.
 */
export type GuardMotions = { enter: string; held: string; exit: string };
export type ReactionMotions = { hit: string; death: string };

export type AnimationControllerOptions = {
  guardMotions?: Partial<GuardMotions>;
  reactionMotions?: Partial<ReactionMotions>;
};

export type AnimationControllerState = {
  baseMotion: string | null;
  /** Motions supplying the held pose, one per part. Empty when there is none. */
  stanceMotions: readonly string[];
  overlayMotion: string | null;
  hitMotion: string | null;
  overrideMotion: string | null;
  abilityInRecovery: boolean;
  dead: boolean;
};

type LayerAction = {
  key: string;
  action: THREE.AnimationAction;
  ruleName: MotionRuleName;
  /** Bands this action claims while it runs. Full-body layers claim everything. */
  width: OverlayWidth;
};

type StancePartLayer = {
  motion: string;
  action: THREE.AnimationAction;
  bands: readonly AnimationBand[];
};

/**
 * A held pose, in as many parts as it took to build. One part for a stance the
 * library ships whole; two for one composed per arm.
 */
type StanceLayer = {
  /** Identity of the whole pose, so re-setting the same one is a no-op. */
  key: string;
  parts: readonly StancePartLayer[];
};

/**
 * Locomotion, split across every disjoint rig band. See `mask.ts`.
 *
 * Per band rather than per region because a stance may hold some of the upper
 * body and not the rest — a shield pose with no sword pose beside it holds the
 * left arm only. Locomotion keeps whatever the stance is not holding, and bones
 * that would otherwise be driven by nothing keep moving with the gait.
 */
type BaseLayer = {
  key: string;
  bands: Partial<Record<AnimationBand, THREE.AnimationAction | null>>;
};

type PendingStop = {
  action: THREE.AnimationAction;
  remainingSeconds: number;
};

/** The most recently requested phased motion — see `playPhased`. */
type ActivePhaseRequest = {
  keys: PhasedKeys;
  ruleNames: PhasedRuleNames;
};

type ActiveChain = {
  spec: ChainSpec;
  index: number;
  options: AbilityPlaybackOptions;
  /** Set when `advanceChain` was called outside the window under `'queue'`. */
  queuedAdvance: boolean;
};

/** Guard is `playPhased`'s first caller, expressed as its own fixed rule triplet. */
const GUARD_PHASE_RULES: PhasedRuleNames = {
  enter: 'guardEnter',
  held: 'guardHeld',
  exit: 'guardExit',
};

export class AnimationController {
  readonly mixer: THREE.AnimationMixer;

  private readonly resolveMotion: MotionResolver;
  private readonly guardMotions: GuardMotions;
  private readonly reactionMotions: ReactionMotions;
  private base: BaseLayer | null = null;
  private stance: StanceLayer | null = null;
  private overlay: LayerAction | null = null;
  private hit: LayerAction | null = null;
  private override: LayerAction | null = null;
  private abilityInRecovery = false;
  /** Whether the most recently requested phased motion wants to be held. */
  private phaseDesired = false;
  /** Keys/rules of the most recently requested phased motion, for `onActionFinished`. */
  private activePhase: ActivePhaseRequest | null = null;
  private chain: ActiveChain | null = null;
  private dead = false;
  private pendingStops: PendingStop[] = [];
  /**
   * Last audibility we asked of each action. Fading in an action that is already
   * audible would dip it to zero first, so every transition goes through here.
   */
  private readonly audible = new WeakMap<THREE.AnimationAction, boolean>();
  /**
   * Weight ramps we drive ourselves. three's fadeIn/fadeOut hardcode the START
   * of the fade at 0 and 1, so reversing one mid-flight snaps the weight to the
   * far end before moving — a layer at 0.4 asked to become audible drops to 0
   * and then rises. Band claims can flip faster than a blend finishes, so the
   * ramp has to start from wherever the weight actually is.
   */
  private readonly ramps = new Map<
    THREE.AnimationAction,
    { from: number; to: number; elapsed: number; duration: number }
  >();
  /**
   * A second identity for a clip that chains into itself.
   *
   * `mixer.clipAction` is memoised per clip, so re-firing the clip that is
   * already running hands back the action still playing it. Arming it calls
   * `reset()`, which yanks it to frame 0 — the outgoing pose is skipped rather
   * than blended, because an action cannot crossfade with itself. A double jab
   * is the ordinary case: the first jab's recovery vanishes and the body cuts.
   *
   * Cloning the clip gives the incoming fire its own action, so the two ends of
   * a self-chain blend like any other pair. Two identities are enough and they
   * alternate on their own — the third fire finds the alternate running and
   * reaches back for the original, by which time it faded out long ago.
   */
  private readonly alternates = new Map<THREE.AnimationClip, THREE.AnimationClip>();

  constructor(
    root: THREE.Object3D,
    resolveMotion: MotionResolver,
    options: AnimationControllerOptions = {},
  ) {
    this.mixer = new THREE.AnimationMixer(root);
    this.resolveMotion = resolveMotion;
    this.guardMotions = { ...DEFAULT_GUARD_MOTIONS, ...options.guardMotions };
    this.reactionMotions = { ...DEFAULT_REACTION_MOTIONS, ...options.reactionMotions };
    this.mixer.addEventListener('finished', this.onActionFinished);
  }

  update(deltaSeconds: number): void {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;

    for (const [action, ramp] of [...this.ramps]) {
      ramp.elapsed += deltaSeconds;
      const t = ramp.duration > 0 ? Math.min(1, ramp.elapsed / ramp.duration) : 1;
      const eased = t * t * (3 - 2 * t);
      action.setEffectiveWeight(ramp.from + (ramp.to - ramp.from) * eased);
      if (t >= 1) this.ramps.delete(action);
    }

    this.pendingStops = this.pendingStops.filter((pending) => {
      pending.remainingSeconds -= deltaSeconds;
      if (pending.remainingSeconds > 0) return true;
      pending.action.stop();
      this.audible.delete(pending.action);
      this.ramps.delete(pending.action);
      return false;
    });
    this.mixer.update(deltaSeconds);
    this.consumeQueuedChainAdvance();
  }

  setLocomotion(key: string): boolean {
    if (this.dead || this.base?.key === key) return false;

    const source = this.resolveMotion(key);
    if (!source) return false;

    const rule = MOTION_RULES.locomotion;
    // Retire the outgoing gait first: arming reclaims any action the two gaits
    // happen to share, and the winner must be the incoming one.
    this.fadeBase(this.base, rule.exitBlendSeconds);
    this.base = {
      key,
      bands: Object.fromEntries(
        ALL_BANDS.map(band => [band, this.armBand(source, [band], rule)]),
      ) as BaseLayer['bands'],
    };
    this.syncBands(rule.enterBlendSeconds);
    return true;
  }

  /**
   * Adopt a held pose for as long as a loadout is equipped, or `null` to drop
   * back to locomotion's own upper body.
   *
   * The stance stands in for the upper bands of locomotion rather than layering
   * on top of them, so one pose covers idle, walk, and run without authoring a
   * gait set per weapon.
   *
   * A bare motion key is the common case and takes the whole upper body. A list
   * of parts composes one pose from several clips, which is how sword-and-board
   * exists at all: the library has a shield pose and a sword pose and nothing
   * that is both.
   *
   * Parts that resolve to nothing are dropped rather than failing the stance —
   * equipment is never blocked by missing art, and the bands a dropped part
   * would have held stay with locomotion.
   */
  setStance(stance: string | readonly StancePart[] | null): boolean {
    if (this.dead) return false;

    const rule = MOTION_RULES.stance;
    const requested: readonly StancePart[] = stance === null
      ? []
      : typeof stance === 'string'
        ? [{ motion: stance, bands: UPPER_BANDS }]
        : stance;

    const resolved = requested
      .map(part => ({ part, clip: this.stanceClip(part.motion, part.bands, part.hold) }))
      .filter((entry): entry is { part: StancePart; clip: THREE.AnimationClip } => entry.clip !== null);

    // Identity covers the bands and the held moment as well as the clips: the
    // same two poses swapped between arms is a different stance, and so is the
    // same clip held at a different frame. Re-setting either must rebuild.
    const nextKey = resolved.length === 0
      ? null
      : resolved
        .map(({ part }) => `${part.motion}@${[...part.bands].join('+')}#${part.hold ?? 'play'}`)
        .join('|');
    if ((this.stance?.key ?? null) === nextKey) return false;

    if (this.stance) {
      for (const part of this.stance.parts) this.fadeAndStop(part.action, rule.exitBlendSeconds);
    }
    this.stance = nextKey === null
      ? null
      : {
        key: nextKey,
        parts: resolved.map(({ part, clip }) => ({
          motion: part.motion,
          action: this.armAction(clip, rule),
          bands: part.bands,
        })),
      };
    this.syncBands(rule.enterBlendSeconds);
    return true;
  }

  playAbility(key: string, options: AbilityPlaybackOptions = {}): boolean {
    const upperBodyOnly = options.upperBodyOnly ?? true;
    if (!upperBodyOnly) {
      return this.playFullBody(key, 'fullBodyAbility');
    }
    if (!this.canStartOverlay()) return false;

    const rule = MOTION_RULES.ability;
    const width: OverlayWidth = (options.movement ?? 0) > 0
      ? 'arms'
      : rule.overlayWidth ?? 'torso';

    const source = this.resolveMotion(key);
    if (!source) return false;
    const masked = this.overlayClip(source, width);
    if (!masked) return false;

    // Masked clips are cached per source and width, so re-firing the running
    // clip lands on its own action here too. See `alternates`.
    const running = this.overlay?.action.getClip();
    const clip = running === masked.clip ? this.alternateOf(masked.clip) : masked.clip;

    this.releaseFullBodyAbilityForOverlay(rule.enterBlendSeconds);
    if (this.overlay) this.fadeAndStop(this.overlay.action, rule.exitBlendSeconds);

    const action = this.mixer.clipAction(clip);
    this.playAction(action, rule);
    this.overlay = { key, action, ruleName: 'ability', width: masked.width };
    this.abilityInRecovery = false;
    this.syncBands(rule.enterBlendSeconds);
    return true;
  }

  /**
   * Play `chain.steps[0]` and remember the chain so `advanceChain` can
   * continue it. Goes through the exact same gating `playAbility` always has —
   * a chain is not a way around the recovery/interruption rules, only a way to
   * advance within them without gameplay re-deriving the timing by hand.
   */
  startChain(chain: ChainSpec, options: AbilityPlaybackOptions = {}): boolean {
    if (chain.steps.length === 0) return false;
    if (!this.playAbility(chain.steps[0]!, options)) return false;
    this.chain = { spec: chain, index: 0, options, queuedAdvance: false };
    return true;
  }

  /**
   * Ask the active chain to advance to its next step.
   *
   * `chain` must be the SAME `ChainSpec` object `startChain` was given —
   * identity, not structural equality, is the whole check for "is this still
   * the chain that's running," so callers should hold one shared constant per
   * chain rather than building a fresh object per call.
   */
  advanceChain(chain: ChainSpec, options: AbilityPlaybackOptions = {}): ChainAdvanceResult {
    const active = this.chain;
    if (!active || active.spec !== chain) return 'inactive';
    if (active.index + 1 >= chain.steps.length) return 'inactive';

    const progress = this.currentChainProgress(active);
    if (progress === null) return 'inactive';

    if (progress >= chain.cancelWindow.fromFraction && progress <= chain.cancelWindow.toFraction) {
      return this.fireNextChainStep(active, options) ? 'advanced' : 'ignored';
    }

    if ((chain.outsideWindow ?? 'ignore') === 'ignore') return 'ignored';
    active.queuedAdvance = true;
    active.options = options;
    return 'queued';
  }

  /**
   * A general "enter once, hold as long as desired, exit once" motion. Guard
   * is this mechanism's first caller (`setGuard`), not a parallel
   * implementation living beside it — every case it handles (a change of mind
   * mid-blend, a repeated report, surviving a full-body interrupt) is handled
   * here, once.
   *
   * Only `held` is required. A missing (or unresolvable) `enter`/`exit` clip
   * degrades to entering/leaving straight from `held` — a caller cannot be
   * blocked by an unauthored transition. A `held` with no clip at all is a
   * silent no-op: presentation must never gate gameplay.
   */
  playPhased(desired: boolean, keys: PhasedKeys, ruleNames: PhasedRuleNames): boolean {
    this.phaseDesired = desired;
    this.activePhase = { keys, ruleNames };
    if (this.dead) return false;

    if (desired) {
      if (
        this.override
        && (this.override.ruleName !== 'fullBodyAbility' || !this.abilityInRecovery)
      ) return false;
      // Already in this phase, or on the way in: nothing to do. An exit in
      // flight is different — the caller changed its mind, and a change of
      // mind inside a brief blend is the most ordinary thing an input can
      // express.
      if (this.isPhaseOverlay(ruleNames)) {
        if (this.overlay?.ruleName !== ruleNames.exit) return false;
      } else if (this.overlay && !this.abilityInRecovery) {
        return false;
      }
      const transitioned = this.startPhaseStep(keys.enter, ruleNames.enter)
        || this.startPhaseStep(keys.held, ruleNames.held);
      if (transitioned) {
        this.releaseFullBodyAbilityForOverlay(MOTION_RULES[this.overlay!.ruleName].enterBlendSeconds);
      }
      return transitioned;
    }

    if (!this.isPhaseOverlay(ruleNames)) return false;
    // Already leaving. Re-reporting the release must not restart the blend.
    if (this.overlay?.ruleName === ruleNames.exit) return false;
    return this.startPhaseStep(keys.exit, ruleNames.exit)
      || this.clearOverlay(MOTION_RULES[ruleNames.exit].exitBlendSeconds);
  }

  /**
   * Gameplay owns ability timing and explicitly opens the recovery interrupt window.
   */
  enterAbilityRecovery(): void {
    if (
      this.overlay?.ruleName === 'ability'
      || this.override?.ruleName === 'fullBodyAbility'
    ) {
      this.abilityInRecovery = true;
    }
  }

  setGuard(held: boolean): boolean {
    return this.playPhased(held, this.guardMotions, GUARD_PHASE_RULES);
  }

  playHitReaction(key: string = this.reactionMotions.hit): boolean {
    if (this.dead || this.override) return false;

    const rule = MOTION_RULES.reactHit;
    const width: OverlayWidth = rule.overlayWidth ?? 'torso';

    const source = this.resolveMotion(key);
    if (!source) return false;
    const masked = this.overlayClip(source, width);
    if (!masked) return false;

    if (this.hit) this.fadeAndStop(this.hit.action, rule.exitBlendSeconds);

    const action = this.mixer.clipAction(masked.clip);
    this.playAction(action, rule);
    this.hit = { key, action, ruleName: 'reactHit', width: masked.width };
    this.syncBands(rule.enterBlendSeconds);
    return true;
  }

  playJump(key = 'jump'): boolean {
    return this.playFullBody(key, 'jump');
  }

  playLand(key = 'land'): boolean {
    return this.playFullBody(key, 'land');
  }

  playDeath(key: string = this.reactionMotions.death): boolean {
    if (this.dead) return false;

    const source = this.resolveMotion(key);
    if (!source) return false;

    const rule = MOTION_RULES.reactDeath;
    const action = this.mixer.clipAction(source);

    this.stopLowerLayers(rule.enterBlendSeconds);
    if (this.override) this.fadeAndStop(this.override.action, rule.enterBlendSeconds);
    this.playAction(action, rule);
    this.override = { key, action, ruleName: 'reactDeath', width: 'torso' };
    this.dead = true;
    return true;
  }

  getState(): AnimationControllerState {
    return {
      baseMotion: this.base?.key ?? null,
      stanceMotions: this.stance?.parts.map(part => part.motion) ?? [],
      overlayMotion: this.overlay?.key ?? null,
      hitMotion: this.hit?.key ?? null,
      overrideMotion: this.override?.key ?? null,
      abilityInRecovery: this.abilityInRecovery,
      dead: this.dead,
    };
  }

  dispose(): void {
    this.mixer.removeEventListener('finished', this.onActionFinished);
    this.mixer.stopAllAction();
    this.pendingStops = [];
    this.ramps.clear();
  }

  // -------------------------------------------------------------------------
  // Band audibility — the single place that decides who drives which bones
  // -------------------------------------------------------------------------

  /**
   * Reconcile every long-lived action against what currently claims each band.
   *
   * Every entry point mutates its own slot and then calls this, so suppression
   * and restoration are derived rather than remembered. Forgetting to restore a
   * layer is the failure mode this exists to make impossible.
   */
  private syncBands(seconds: number): void {
    const overridden = this.override !== null;

    // Stance first, because locomotion's answer depends on it. A part is
    // audible only when every band it owns is free: an action carries one
    // weight and cannot be half-suppressed, so a part whose arm has been
    // claimed steps aside whole.
    const held = new Set<AnimationBand>();
    for (const part of this.stance?.parts ?? []) {
      const free = !overridden && part.bands.every(band => !this.claimed(band));
      this.setAudible(part.action, free, seconds);
      if (free) for (const band of part.bands) held.add(band);
    }

    // A stance replaces locomotion band by band, so whatever it is not holding
    // right now — because no part covers it, or because the part covering it
    // stepped aside — keeps moving with the gait instead of falling to rest.
    for (const band of ALL_BANDS) {
      this.setAudible(
        this.base?.bands[band] ?? null,
        !overridden && !this.claimed(band) && !held.has(band),
        seconds,
      );
    }

    this.setAudible(this.overlay?.action ?? null, !overridden, seconds);
    this.setAudible(this.hit?.action ?? null, !overridden, seconds);
  }

  private claimed(band: AnimationBand): boolean {
    for (const claim of [this.overlay, this.hit]) {
      if (!claim) continue;
      const bands: readonly AnimationBand[] = OVERLAY_BANDS[claim.width];
      if (bands.includes(band)) return true;
    }
    return false;
  }

  private setAudible(
    action: THREE.AnimationAction | null,
    audible: boolean,
    seconds: number,
  ): void {
    if (!action) return;
    if (this.audible.get(action) === audible) return;
    this.audible.set(action, audible);

    action.stopFading();
    if (audible) {
      // three.js disables an action when a fade-out reaches zero weight, and
      // play() does not re-enable it — a disabled action always evaluates to
      // weight 0, however it is faded afterwards. Without this a layer never
      // becomes audible again after being suppressed and the bones it owns sit
      // in the rig's rest pose (a T-pose) forever.
      action.enabled = true;
      this.cancelPendingStop(action);
    }

    if (seconds <= 0) {
      this.ramps.delete(action);
      action.setEffectiveWeight(audible ? 1 : 0);
      if (audible) action.play();
      return;
    }

    this.ramps.set(action, {
      from: action.getEffectiveWeight(),
      to: audible ? 1 : 0,
      elapsed: 0,
      duration: seconds,
    });
    if (audible) action.play();
  }

  // -------------------------------------------------------------------------

  private playFullBody(key: string, ruleName: 'jump' | 'land' | 'fullBodyAbility'): boolean {
    if (this.dead) return false;

    const rule = MOTION_RULES[ruleName];
    if (this.override && !this.canInterrupt(this.override, rule)) return false;
    if (
      ruleName === 'fullBodyAbility'
      && this.overlay?.ruleName === 'ability'
      && !this.abilityInRecovery
    ) return false;

    const source = this.resolveMotion(key);
    if (!source) return false;

    // Chaining a clip into itself needs a second identity to blend against.
    // See `alternates`.
    const running = this.override?.action.getClip();
    const clip = running === source ? this.alternateOf(source) : source;

    if (this.override) {
      this.fadeAndStop(this.override.action, rule.enterBlendSeconds);
    }

    const action = this.mixer.clipAction(clip);
    this.playAction(action, rule);
    this.override = { key, action, ruleName, width: 'torso' };
    this.abilityInRecovery = false;
    this.syncBands(rule.enterBlendSeconds);
    return true;
  }

  /**
   * Arm and play one phase step onto the overlay slot. `key` may be absent —
   * a missing enter/exit is how `playPhased` degrades to `held` alone — and a
   * key with no resolvable (or fully-masked-away) clip is treated the same
   * way: this returns `false` and touches nothing, so callers can chain
   * attempts with `||` exactly like the old guard-specific version did.
   */
  private startPhaseStep(key: string | undefined, ruleName: MotionRuleName): boolean {
    if (!key) return false;
    // Widened to `MotionRule`: `ruleName` ranges over every rule here, not just
    // the three guard used to be pinned to, and only some declare `overlayWidth`.
    const rule: MotionRule = MOTION_RULES[ruleName];
    const width: OverlayWidth = rule.overlayWidth ?? 'arms';

    const source = this.resolveMotion(key);
    if (!source) return false;
    const masked = this.overlayClip(source, width);
    if (!masked) return false;

    if (this.overlay) {
      this.fadeAndStop(this.overlay.action, rule.enterBlendSeconds);
    }
    const action = this.mixer.clipAction(masked.clip);
    this.playAction(action, rule);
    this.overlay = { key, action, ruleName, width: masked.width };
    this.abilityInRecovery = false;
    this.syncBands(rule.enterBlendSeconds);
    return true;
  }

  private isPhaseOverlay(ruleNames: PhasedRuleNames): boolean {
    return this.overlay?.ruleName === ruleNames.enter
      || this.overlay?.ruleName === ruleNames.held
      || this.overlay?.ruleName === ruleNames.exit;
  }

  /**
   * Current step's progress (0..1) through its own clip duration, for the
   * layer the chain is running on. `null` if that layer no longer belongs to
   * this chain — something else claimed it since the step started — in which
   * case the chain is cleared: a stale reference must never let a later
   * `advanceChain` misfire into a layer something else now owns.
   */
  private currentChainProgress(active: ActiveChain): number | null {
    const currentKey = active.spec.steps[active.index];
    const upperBodyOnly = active.options.upperBodyOnly ?? true;
    const running = upperBodyOnly ? this.overlay : this.override;
    if (!running || running.key !== currentKey) {
      this.chain = null;
      return null;
    }
    const duration = running.action.getClip().duration;
    if (duration <= 0) return 1;
    return Math.min(1, Math.max(0, running.action.time / duration));
  }

  /**
   * Fire `active.spec.steps[active.index + 1]`, replacing the current step.
   * This deliberately reuses `playAbility` rather than duplicating its
   * crossfade/self-chain logic: it opens the recovery window first (the same
   * door gameplay uses, and the same one the drill's hand-timed `cancelAfter`
   * used to open by hand) and lets `playAbility` do everything else, including
   * the `alternates` swap when a step repeats the clip already playing.
   */
  private fireNextChainStep(active: ActiveChain, options: AbilityPlaybackOptions): boolean {
    const nextKey = active.spec.steps[active.index + 1]!;
    this.enterAbilityRecovery();
    if (!this.playAbility(nextKey, options)) return false;
    active.index += 1;
    active.options = options;
    active.queuedAdvance = false;
    return true;
  }

  /** Consume a queued chain advance once playback reaches the cancel window. */
  private consumeQueuedChainAdvance(): void {
    const active = this.chain;
    if (!active || !active.queuedAdvance) return;

    const progress = this.currentChainProgress(active);
    if (progress === null) return;
    if (progress < active.spec.cancelWindow.fromFraction) return;
    if (progress > active.spec.cancelWindow.toFraction) {
      // The window closed before this ever got consumed — drop it rather than
      // fire a step late into whatever comes after.
      active.queuedAdvance = false;
      return;
    }
    this.fireNextChainStep(active, active.options);
  }

  private canStartOverlay(): boolean {
    if (this.dead) return false;
    if (this.override) {
      return this.override.ruleName === 'fullBodyAbility' && this.abilityInRecovery;
    }
    if (!this.overlay) return true;
    return this.overlay.ruleName === 'ability' && this.abilityInRecovery;
  }

  private releaseFullBodyAbilityForOverlay(seconds: number): void {
    if (this.override?.ruleName !== 'fullBodyAbility') return;
    this.fadeAndStop(this.override.action, seconds);
    this.override = null;
    this.syncBands(seconds);
  }

  private canInterrupt(current: LayerAction, nextRule: MotionRule): boolean {
    const currentRule = MOTION_RULES[current.ruleName];
    if (currentRule.interruption === 'never') return false;
    if (currentRule.interruption === 'recovery' && !this.abilityInRecovery) return false;
    return nextRule.priority >= currentRule.priority;
  }

  /** Configure and start an action silently; `syncBands` decides if it is heard. */
  private armAction(clip: THREE.AnimationClip, rule: MotionRule): THREE.AnimationAction {
    const action = this.mixer.clipAction(clip);
    this.cancelPendingStop(action);
    this.ramps.delete(action);
    action.stopFading();
    action
      .reset()
      .setLoop(
        rule.loop === 'repeat' ? THREE.LoopRepeat : THREE.LoopOnce,
        rule.loop === 'repeat' ? Infinity : 1,
      )
      .setEffectiveWeight(0);
    action.clampWhenFinished = rule.clampWhenFinished;
    action.enabled = true;
    action.play();
    this.audible.set(action, false);
    return action;
  }

  private armBand(
    source: THREE.AnimationClip,
    bands: readonly AnimationBand[],
    rule: MotionRule,
  ): THREE.AnimationAction | null {
    const clip = maskClipToBands(source, bands);
    return clip.tracks.length > 0 ? this.armAction(clip, rule) : null;
  }

  /**
   * Mask a clip to an overlay width, widening if that would erase it.
   *
   * A clip authored entirely on the lower spine has no tracks left under the
   * `arms` mask, and an empty clip plays as nothing at all — the exact failure
   * this whole layer exists to prevent. Better to let a narrow action reach into
   * the torso and fight the gait a little than to have the player press a button
   * and see their character do nothing.
   */
  /** The clone a self-chaining clip blends against. See `alternates`. */
  private alternateOf(clip: THREE.AnimationClip): THREE.AnimationClip {
    const existing = this.alternates.get(clip);
    if (existing) return existing;
    const alternate = clip.clone();
    this.alternates.set(clip, alternate);
    return alternate;
  }

  private overlayClip(
    source: THREE.AnimationClip,
    width: OverlayWidth,
  ): { clip: THREE.AnimationClip; width: OverlayWidth } | null {
    const clip = maskClipToOverlay(source, width);
    if (clip.tracks.length > 0) return { clip, width };
    if (width === 'arms') {
      const widened = maskClipToOverlay(source, 'torso');
      // The claim widens with the clip: whatever it drives, nothing else may.
      if (widened.tracks.length > 0) return { clip: widened, width: 'torso' };
    }
    return null;
  }

  private stanceClip(
    key: string,
    bands: readonly AnimationBand[],
    hold?: number | 'end',
  ): THREE.AnimationClip | null {
    const source = this.resolveMotion(key);
    if (!source) return null;
    // A stance never widens — it is a background pose, and one that reached into
    // the lower spine would fight every gait it is worn over.
    const masked = maskClipToBands(source, bands);
    // Masked first, so freezing samples only the tracks the pose keeps.
    const clip = hold === undefined ? masked : freezeClipAt(masked, hold);
    return clip.tracks.length > 0 ? clip : null;
  }

  private playAction(action: THREE.AnimationAction | null, rule: MotionRule): void {
    if (!action) return;
    this.cancelPendingStop(action);
    this.ramps.delete(action);
    action.stopFading();
    action
      .reset()
      .setLoop(
        rule.loop === 'repeat' ? THREE.LoopRepeat : THREE.LoopOnce,
        rule.loop === 'repeat' ? Infinity : 1,
      )
      .setEffectiveWeight(1);
    action.clampWhenFinished = rule.clampWhenFinished;
    action.enabled = true;
    action.fadeIn(rule.enterBlendSeconds).play();
    this.audible.set(action, true);
  }

  private fadeBase(base: BaseLayer | null, seconds: number): void {
    if (!base) return;
    for (const band of ALL_BANDS) this.fadeAndStop(base.bands[band] ?? null, seconds);
  }

  private stopLowerLayers(seconds: number): void {
    this.fadeBase(this.base, seconds);
    if (this.stance) {
      for (const part of this.stance.parts) this.fadeAndStop(part.action, seconds);
    }
    if (this.overlay) this.fadeAndStop(this.overlay.action, seconds);
    if (this.hit) this.fadeAndStop(this.hit.action, seconds);
    this.base = null;
    this.stance = null;
    this.overlay = null;
    this.hit = null;
    this.abilityInRecovery = false;
    this.phaseDesired = false;
    this.chain = null;
  }

  private fadeAndStop(action: THREE.AnimationAction | null, seconds: number): void {
    if (!action) return;
    this.ramps.delete(action);
    action.fadeOut(seconds);
    this.audible.set(action, false);
    this.pendingStops = this.pendingStops.filter((pending) => pending.action !== action);
    this.pendingStops.push({ action, remainingSeconds: seconds });
  }

  private cancelPendingStop(action: THREE.AnimationAction): void {
    this.pendingStops = this.pendingStops.filter((pending) => pending.action !== action);
  }

  private clearOverlay(seconds: number): boolean {
    if (!this.overlay) return false;
    this.fadeAndStop(this.overlay.action, seconds);
    this.overlay = null;
    this.abilityInRecovery = false;
    this.syncBands(seconds);
    return true;
  }

  private readonly onActionFinished = (
    event: { action: THREE.AnimationAction; direction: number },
  ): void => {
    if (this.override?.action === event.action) {
      if (this.override.ruleName === 'reactDeath') return;
      const rule = MOTION_RULES[this.override.ruleName];
      this.fadeAndStop(event.action, rule.exitBlendSeconds);
      this.override = null;
      this.abilityInRecovery = false;
      this.syncBands(rule.exitBlendSeconds);
      // playPhased rather than startPhaseStep: the overlay may still be an
      // exit the caller already reversed, and only playPhased knows that is
      // interruptible.
      if (this.phaseDesired && this.activePhase) {
        this.playPhased(true, this.activePhase.keys, this.activePhase.ruleNames);
      }
      return;
    }

    if (this.hit?.action === event.action) {
      const rule = MOTION_RULES.reactHit;
      this.fadeAndStop(event.action, rule.exitBlendSeconds);
      this.hit = null;
      this.syncBands(rule.exitBlendSeconds);
      return;
    }

    if (this.overlay?.action !== event.action) return;
    const finished = this.overlay;
    const rule = MOTION_RULES[finished.ruleName];
    this.fadeAndStop(event.action, rule.exitBlendSeconds);
    this.overlay = null;
    this.abilityInRecovery = false;

    const phase = this.activePhase;
    if (phase && finished.ruleName === phase.ruleNames.enter && this.phaseDesired) {
      if (this.startPhaseStep(phase.keys.held, phase.ruleNames.held)) return;
    } else if (phase && finished.ruleName === phase.ruleNames.held && !this.phaseDesired) {
      if (this.startPhaseStep(phase.keys.exit, phase.ruleNames.exit)) return;
    } else if (phase && this.phaseDesired && !this.override) {
      // Whatever just ended — an exit the caller reversed, or an ability fired
      // while the phase was still desired — the layer is free and the phase
      // wants it.
      if (
        this.startPhaseStep(phase.keys.enter, phase.ruleNames.enter)
        || this.startPhaseStep(phase.keys.held, phase.ruleNames.held)
      ) return;
    }

    this.syncBands(rule.exitBlendSeconds);
  };
}
