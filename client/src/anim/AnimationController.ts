import * as THREE from 'three';
import {
  DEFAULT_GUARD_MOTIONS,
  DEFAULT_REACTION_MOTIONS,
  MOTION_RULES,
  type MotionRule,
  type MotionRuleName,
} from './config';
import {
  maskClipToBands,
  maskClipToOverlay,
  OVERLAY_BANDS,
  type AnimationBand,
  type OverlayWidth,
} from './mask';

export type MotionResolver = (key: string) => THREE.AnimationClip | null;

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
  stanceMotion: string | null;
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

type StanceLayer = {
  key: string;
  action: THREE.AnimationAction;
};

/** Locomotion, split across the three disjoint rig bands. See `mask.ts`. */
type BaseLayer = {
  key: string;
  lower: THREE.AnimationAction | null;
  mid: THREE.AnimationAction | null;
  upper: THREE.AnimationAction | null;
};

type PendingStop = {
  action: THREE.AnimationAction;
  remainingSeconds: number;
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
  private guardDesired = false;
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
      lower: this.armBand(source, ['lower'], rule),
      mid: this.armBand(source, ['mid'], rule),
      upper: this.armBand(source, ['upper'], rule),
    };
    this.syncBands(rule.enterBlendSeconds);
    return true;
  }

  /**
   * Adopt a held pose for as long as a loadout is equipped, or `null` to drop
   * back to locomotion's own upper body.
   *
   * The stance stands in for the upper band of locomotion rather than layering
   * on top of it, so one pose covers idle, walk, and run without authoring a
   * gait set per weapon. A stance with no clip degrades to no stance: equipment
   * is never blocked by missing art.
   */
  setStance(key: string | null): boolean {
    if (this.dead) return false;

    const rule = MOTION_RULES.stance;
    const clip = key === null ? null : this.stanceClip(key);
    const nextKey = clip === null ? null : key;
    if ((this.stance?.key ?? null) === nextKey) return false;

    if (this.stance) this.fadeAndStop(this.stance.action, rule.exitBlendSeconds);
    this.stance = clip === null || nextKey === null
      ? null
      : { key: nextKey, action: this.armAction(clip, rule) };
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

    this.releaseFullBodyAbilityForOverlay(rule.enterBlendSeconds);
    if (this.overlay) this.fadeAndStop(this.overlay.action, rule.exitBlendSeconds);

    const action = this.mixer.clipAction(masked.clip);
    this.playAction(action, rule);
    this.overlay = { key, action, ruleName: 'ability', width: masked.width };
    this.abilityInRecovery = false;
    this.syncBands(rule.enterBlendSeconds);
    return true;
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
    this.guardDesired = held;
    if (this.dead) return false;

    if (held) {
      if (
        this.override
        && (
          this.override.ruleName !== 'fullBodyAbility'
          || !this.abilityInRecovery
        )
      ) return false;
      if (this.isGuardOverlay()) return false;
      if (this.overlay && !this.abilityInRecovery) return false;
      const transitioned = this.startGuardMotion('guardEnter', this.guardMotions.enter)
        || this.startGuardMotion('guardHeld', this.guardMotions.held);
      if (transitioned) {
        this.releaseFullBodyAbilityForOverlay(MOTION_RULES.guardEnter.enterBlendSeconds);
      }
      return transitioned;
    }

    if (!this.isGuardOverlay()) return false;
    return this.startGuardMotion('guardExit', this.guardMotions.exit)
      || this.clearOverlay(MOTION_RULES.guardExit.exitBlendSeconds);
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
      stanceMotion: this.stance?.key ?? null,
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
    const stanceAction = this.stance?.action ?? null;

    this.setAudible(this.base?.lower ?? null, !overridden, seconds);
    this.setAudible(this.base?.mid ?? null, !overridden && !this.claimed('mid'), seconds);

    const upperFree = !overridden && !this.claimed('upper');
    // A stance replaces locomotion's upper body; they are never both audible.
    this.setAudible(this.base?.upper ?? null, upperFree && stanceAction === null, seconds);
    this.setAudible(stanceAction, upperFree, seconds);

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

    if (this.override) {
      this.fadeAndStop(this.override.action, rule.enterBlendSeconds);
    }

    const action = this.mixer.clipAction(source);
    this.playAction(action, rule);
    this.override = { key, action, ruleName, width: 'torso' };
    this.abilityInRecovery = false;
    this.syncBands(rule.enterBlendSeconds);
    return true;
  }

  private startGuardMotion(
    ruleName: 'guardEnter' | 'guardHeld' | 'guardExit',
    key: string,
  ): boolean {
    const rule = MOTION_RULES[ruleName];
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

  private stanceClip(key: string): THREE.AnimationClip | null {
    const source = this.resolveMotion(key);
    if (!source) return null;
    // A stance never widens — it is a background pose, and one that reached into
    // the lower spine would fight every gait it is worn over.
    const clip = maskClipToOverlay(source, MOTION_RULES.stance.overlayWidth ?? 'arms');
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
    this.fadeAndStop(base.lower, seconds);
    this.fadeAndStop(base.mid, seconds);
    this.fadeAndStop(base.upper, seconds);
  }

  private stopLowerLayers(seconds: number): void {
    this.fadeBase(this.base, seconds);
    if (this.stance) this.fadeAndStop(this.stance.action, seconds);
    if (this.overlay) this.fadeAndStop(this.overlay.action, seconds);
    if (this.hit) this.fadeAndStop(this.hit.action, seconds);
    this.base = null;
    this.stance = null;
    this.overlay = null;
    this.hit = null;
    this.abilityInRecovery = false;
    this.guardDesired = false;
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

  private isGuardOverlay(): boolean {
    return this.overlay?.ruleName === 'guardEnter'
      || this.overlay?.ruleName === 'guardHeld'
      || this.overlay?.ruleName === 'guardExit';
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
      if (this.guardDesired && !this.overlay) {
        this.startGuardMotion('guardEnter', this.guardMotions.enter)
          || this.startGuardMotion('guardHeld', this.guardMotions.held);
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

    if (finished.ruleName === 'guardEnter' && this.guardDesired) {
      if (this.startGuardMotion('guardHeld', this.guardMotions.held)) return;
    } else if (finished.ruleName === 'guardHeld' && !this.guardDesired) {
      if (this.startGuardMotion('guardExit', this.guardMotions.exit)) return;
    }

    this.syncBands(rule.exitBlendSeconds);
  };
}
