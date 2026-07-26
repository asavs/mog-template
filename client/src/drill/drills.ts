/**
 * Training routines: a scripted run through everything one loadout needs.
 *
 * The clip browser answers "what is this animation". A drill answers the
 * question after it — "does this set of animations hold together as a
 * character" — which no single clip can be asked. It plays a fixed sequence so
 * the same thing happens every time, and names each step out loud so a problem
 * can be reported as "step 9 looks wrong" rather than described from memory.
 *
 * Each step is a combination, not a clip: a gait, an action over it, and the
 * WIDTH the action claims. Width is the interesting axis and the reason a drill
 * repeats the same swing three times:
 *
 *   full   a full-body override. The action owns the legs; the character roots.
 *   torso  overlay claiming mid + core + both arms. Legs keep walking.
 *   arms   overlay claiming core + both arms. The lower spine keeps the gait's
 *          counter-rotation, which is what a clip has to survive to be usable
 *          while moving.
 *
 * A clip authored full-body looks wrong at `arms` and rooted at `full`, and
 * which of those is acceptable is a design decision per ability rather than a
 * property of the clip. Seeing all three back to back is how that gets decided.
 *
 * Steps name clips by their library name (`Sword_Regular_A`), not by motion key,
 * because most of what a drill exercises is not bound to a key yet — that is
 * rather the point of running one.
 *
 * `docs/character-pipeline.md` is the plan these routines serve, and the place
 * where the open question about this file is written down: a `Drill` is the
 * preset table that plan asks for, one layer up from where it asked for it.
 */

import { STANCE_KEYS, type StanceKey } from '../content';

/** How much of the body an action claims. See the note above. */
export type DrillWidth = 'full' | 'torso' | 'arms';

export type DrillStep = {
  /** What this step is called, on screen and to each other. */
  label: string;
  /** What to watch for. Shown while the step runs. */
  note?: string;
  /**
   * The gait underneath — a motion key, or the name of a library clip for a
   * gait nothing has bound yet. Both resolve, and a crouch has no key while
   * being exactly the sort of thing worth trying under an action.
   */
  gait: string;
  /** Library clip name to fire over it. Omitted for a step that is just a gait. */
  action?: string;
  width?: DrillWidth;
  /** Override the dwell. Defaults to the action's length plus a beat. */
  seconds?: number;
  /**
   * Replace the pause after a one-shot. Zero runs straight into the next step.
   *
   * A pause is right when you are inspecting one motion and wrong when you are
   * asking whether two of them join — which is most of what a combination is.
   */
  tail?: number;
  /**
   * Seconds into the action when its recovery window opens, letting the NEXT
   * step interrupt instead of waiting.
   *
   * This is what a combination is: not two clips played back to back, but a
   * second cutting into the first before it has finished recovering. The
   * controller already gates on exactly this — gameplay is meant to own ability
   * timing — so a drill goes through the same door the game would, and what you
   * see here is what the game would do.
   */
  cancelAfter?: number;
};

export type Drill = {
  id: string;
  label: string;
  note: string;
  /** Scene to run it in. */
  sceneId: string;
  /** Held pose worn throughout. Its slots fill the hands. */
  stance: StanceKey | null;
  steps: readonly DrillStep[];
};

/** Long enough after a one-shot to see it settle back rather than cut away. */
export const STEP_TAIL_SECONDS = 0.9;

const IDLE = 'motion.loco_idle';
const WALK = 'motion.loco_walk_f';
const JOG = 'motion.loco_run_f';

/**
 * Crouches, used as gaits by clip name because nothing binds them to a key.
 *
 * They matter most as the posture an action falls BACK to. When a one-shot
 * ends, the body returns to whatever gait is underneath it, and for an unarmed
 * fighter that would otherwise be `Idle_Loop` — hands at the sides. Neither of
 * these is a fighting guard, but both hold a lowered, weighted posture, which
 * is the nearest thing the library has.
 */
const WEAVE = 'Crouch_Idle_Loop';
const SLIP = 'Crouch_Fwd_Loop';

/**
 * Sword and board.
 *
 * Ordered as a session rather than as a list: guard up, move, strike, work the
 * combo string, defend, take a beating, get up. It ends on the floor and stands
 * back up because `Death01` and `LayToIdle` are a matched pair and neither is
 * judgeable without the other.
 */
const SWORD_AND_BOARD: Drill = {
  id: 'warrior-sword-shield',
  label: 'warrior — sword & shield',
  note: 'Every motion a sword-and-board loadout needs, each at the widths it might be played at.',
  sceneId: 'drill-yard',
  stance: STANCE_KEYS.swordShield,
  steps: [
    {
      label: 'guard up',
      note: 'The composed stance, standing. Shield arm from one clip, sword arm from another.',
      gait: IDLE,
      seconds: 3,
    },
    {
      label: 'guard, walking',
      note: 'Same pose over a walk. A stance claims to cover every gait — this is that claim.',
      gait: WALK,
      seconds: 3.5,
    },
    {
      label: 'guard, jogging',
      note: 'And over a jog. The arms should not change.',
      gait: JOG,
      seconds: 3.5,
    },

    {
      label: 'basic swing — rooted',
      note: 'Sword_Attack as a full-body override. The one sword clip that ends where it started.',
      gait: IDLE,
      action: 'Sword_Attack',
      width: 'full',
    },
    {
      label: 'basic swing — torso, over a jog',
      note: 'Same clip, legs left to the gait. Watch whether the swing still reads.',
      gait: JOG,
      action: 'Sword_Attack',
      width: 'torso',
    },
    {
      label: 'basic swing — arms, over a jog',
      note: 'Narrowest claim. The lower spine keeps the jog, so the torso counter-rotates under the swing.',
      gait: JOG,
      action: 'Sword_Attack',
      width: 'arms',
    },

    {
      label: 'combo 1',
      note: 'Sword_Regular_A. Ends 26 degrees from where it began — it expects a successor.',
      gait: IDLE,
      action: 'Sword_Regular_A',
      width: 'full',
    },
    {
      label: 'combo 1 — recovery',
      note: 'What should follow it on release. Played alone the join is visible; chained it should not be.',
      gait: IDLE,
      action: 'Sword_Regular_A_Rec',
      width: 'full',
    },
    {
      label: 'combo 2',
      gait: IDLE,
      action: 'Sword_Regular_B',
      width: 'full',
    },
    {
      label: 'combo 2 — recovery',
      gait: IDLE,
      action: 'Sword_Regular_B_Rec',
      width: 'full',
    },
    {
      label: 'combo 3 — finisher',
      note: 'Spinning. The pelvis swings 174 degrees.',
      gait: IDLE,
      action: 'Sword_Regular_C',
      width: 'full',
    },
    {
      label: 'the whole string, pre-baked',
      note: 'A+B+C as one clip. Compare its joins against the three links above.',
      gait: IDLE,
      action: 'Sword_Regular_Combo',
      width: 'full',
    },
    {
      label: 'heavy string',
      note: 'Four seconds, and it carries the body 4.7 units. Watch the feet slide.',
      gait: IDLE,
      action: 'Sword_Heavy_Combo',
      width: 'full',
    },

    {
      label: 'shield bash — rooted',
      gait: IDLE,
      action: 'Shield_OneShot',
      width: 'full',
    },
    {
      label: 'shield bash — arms, over a jog',
      note: 'Upper-only clip, so this is the one most likely to survive being played while moving.',
      gait: JOG,
      action: 'Shield_OneShot',
      width: 'arms',
    },
    {
      label: 'shield charge',
      note: 'Travels 0.40. A gap closer, if the game moves the body to match.',
      gait: IDLE,
      action: 'Shield_Dash',
      width: 'full',
    },
    {
      label: 'sword lunge',
      gait: IDLE,
      action: 'Sword_Dash',
      width: 'full',
    },

    {
      label: 'block',
      note: 'The held guard. Loops, so it is the pose a hold-to-block would sit in.',
      gait: IDLE,
      action: 'Sword_Block',
      width: 'torso',
      seconds: 2.4,
    },
    {
      label: 'guard broken',
      note: 'The shield arm knocked open — the same arm the stance raises. A matched pair.',
      gait: IDLE,
      action: 'Idle_Shield_Break',
      width: 'torso',
    },

    {
      label: 'hit while jogging',
      note: 'A flinch narrow enough to not interrupt the legs.',
      gait: JOG,
      action: 'Hit_Chest',
      width: 'arms',
    },
    {
      label: 'knocked back',
      note: 'Travels 0.55. The heavy tier of the same reaction.',
      gait: IDLE,
      action: 'Hit_Knockback',
      width: 'full',
    },
    {
      label: 'down',
      gait: IDLE,
      action: 'Death01',
      width: 'full',
    },
    {
      label: 'back up',
      note: 'Starts prone, where Death01 leaves off. Together they are a full down-and-revive.',
      gait: IDLE,
      action: 'LayToIdle',
      width: 'full',
    },
  ],
};

/**
 * Unarmed.
 *
 * Shadowboxing, and shaped that way because unarmed is where combinations are
 * the whole content. A sword has reach and weight to sell a single swing; a
 * fist has neither, and a jab on its own reads as a twitch. So this routine
 * throws each punch alone first — which is the only way to see what it is — and
 * then throws the same punches as a one-two and a one-two-three, cancelling
 * each into the next through the controller's real recovery window.
 *
 * The joins hold. `Punch_Hook` drops the body 0.29 and `Punch_Hook_Rec` raises
 * it back, which was expected to make a hook cut into from the cross read as
 * standing up out of a crouch nobody saw them enter — it does not.
 *
 * What this routine shows instead is the gap BETWEEN singles. An action that
 * ends with nothing behind it falls back to the gait, and this routine holds
 * each punch long enough to watch that happen — which is the point when
 * inspecting one, and wrong when asking whether two of them join.
 * `fighter-shadowbox` is where the same punches run without the pause.
 *
 * Unarmed wears a guard: `stance.unarmed` holds `Punch_Hook_Rec` at its last
 * frame across both arms, so the hands come back UP between punches rather than
 * down to the sides. Every single here is therefore judged against the pose the
 * character actually returns to.
 */
const UNARMED: Drill = {
  id: 'fighter-unarmed',
  label: 'fighter — unarmed',
  note: 'Every punch alone, then the same punches as combinations. The joins are the point.',
  sceneId: 'sparring-pit',
  stance: STANCE_KEYS.unarmed,
  steps: [
    {
      label: 'on guard',
      note: 'The guard, standing. Both arms held at the last frame of Punch_Hook_Rec; the chest and head still breathe with the idle underneath.',
      gait: IDLE,
      seconds: 3,
    },
    {
      label: 'circling',
      gait: WALK,
      seconds: 3.5,
    },
    {
      label: 'stepping in',
      gait: JOG,
      seconds: 3,
    },

    {
      label: 'jab',
      note: 'Left lead. 0.87 s, and the left forearm swings 120 degrees.',
      gait: IDLE,
      action: 'Punch_Jab',
      width: 'full',
    },
    {
      label: 'jab, moving',
      note: 'Same punch at arms width over a walk — the narrowest claim, and the test of whether it survives being thrown on the move.',
      gait: WALK,
      action: 'Punch_Jab',
      width: 'arms',
    },
    {
      label: 'cross',
      note: 'Rear hand. The mirror of the jab, 126 degrees on the right forearm.',
      gait: IDLE,
      action: 'Punch_Cross',
      width: 'full',
    },
    {
      label: 'cross, moving',
      gait: JOG,
      action: 'Punch_Cross',
      width: 'arms',
    },
    {
      label: 'hook',
      note: 'Drops the body 0.29 and steps 0.21. It is a whole-body punch and will not survive a narrow mask.',
      gait: IDLE,
      action: 'Punch_Hook',
      width: 'full',
    },
    {
      label: 'hook, recovering',
      note: 'Rises 0.33 — the way back up out of the hook. Alone it looks like standing up for no reason. Its last frame is also where the guard comes from, so watch where it leaves the hands.',
      gait: IDLE,
      action: 'Punch_Hook_Rec',
      width: 'full',
    },

    {
      label: 'one–two: jab',
      note: 'Cancelled at 0.45 s so the cross can cut in. Watch the join, not the punch.',
      gait: IDLE,
      action: 'Punch_Jab',
      width: 'full',
      cancelAfter: 0.45,
      seconds: 0.5,
    },
    {
      label: 'one–two: cross',
      gait: IDLE,
      action: 'Punch_Cross',
      width: 'full',
      tail: 0.5,
    },

    {
      label: 'one–two–three: jab',
      gait: IDLE,
      action: 'Punch_Jab',
      width: 'full',
      cancelAfter: 0.4,
      seconds: 0.45,
    },
    {
      label: 'one–two–three: cross',
      gait: IDLE,
      action: 'Punch_Cross',
      width: 'full',
      cancelAfter: 0.5,
      seconds: 0.55,
    },
    {
      label: 'one–two–three: hook',
      note: 'The finisher, cut into from the cross. If any join in the routine is going to look wrong it is this one.',
      gait: IDLE,
      action: 'Punch_Hook',
      width: 'full',
      tail: 0,
    },
    {
      label: 'out of the hook',
      gait: IDLE,
      action: 'Punch_Hook_Rec',
      width: 'full',
    },

    {
      label: 'ducking',
      note: 'Crouch as a gait. No key is bound to it, so this runs the library clip by name.',
      gait: 'Crouch_Idle_Loop',
      seconds: 3,
    },
    {
      label: 'weaving',
      gait: 'Crouch_Fwd_Loop',
      seconds: 3.5,
    },
    {
      label: 'rolling away',
      note: 'A dodge. Travels 0.37, so the game would have to move the body to match.',
      gait: IDLE,
      action: 'Roll',
      width: 'full',
    },

    {
      label: 'caught on the chin',
      gait: IDLE,
      action: 'Hit_Head',
      width: 'arms',
    },
    {
      label: 'caught in the body, moving',
      note: 'Narrow enough not to interrupt the legs, which is what makes it usable mid-exchange.',
      gait: JOG,
      action: 'Hit_Chest',
      width: 'arms',
    },
    {
      label: 'dropped',
      gait: IDLE,
      action: 'Hit_Knockback',
      width: 'full',
    },
    {
      label: 'down',
      gait: IDLE,
      action: 'Death01',
      width: 'full',
    },
    {
      label: 'up at the count',
      gait: IDLE,
      action: 'LayToIdle',
      width: 'full',
    },
  ],
};

/**
 * Unarmed again, as a performance rather than an inventory.
 *
 * `fighter-unarmed` throws each punch alone so it can be identified, which
 * means the body finishes every one of them and falls back to locomotion. For
 * unarmed that fallback is `Idle_Loop` — a man standing with his hands at his
 * sides — so the routine reads as a list of moves separated by a pedestrian.
 * That is a true report of the clips and a false report of the character.
 *
 * This one asks the other question: given that each punch is fine, does a
 * fighter made of them look like a fighter? So nothing is inspected. Every
 * one-shot either cancels into the next or ends with `tail: 0`, and the round
 * is built out of footwork rather than pauses.
 *
 * The gait under a punch is a CROUCH rather than idle. At `full` width the gait
 * is invisible while the action runs, so this is not about how the punch looks
 * — it is about what the body lands in when the punch ends. The arms are the
 * stance's; the crouch supplies the rest, and a fighter between combinations is
 * lowered and weighted rather than standing straight.
 *
 * The round ends on `IDLE` so the guard is seen once over a neutral stand,
 * without a crouch underneath it doing half the work.
 *
 * Timings are the ones `fighter-unarmed` established rather than new guesses,
 * except two labelled experiments: a jab thrown at `torso` while walking, and a
 * combination cut ~0.05 tighter than the proven one.
 */
const SHADOWBOX: Drill = {
  id: 'fighter-shadowbox',
  label: 'fighter — shadowboxing (round)',
  note: 'The same punches as a continuous round. Nothing is inspected; the question is whether it reads as a fighter.',
  sceneId: 'sparring-pit',
  stance: STANCE_KEYS.unarmed,
  steps: [
    {
      label: 'circling in',
      note: 'Footwork is the connective tissue. Everywhere this round would otherwise rest on idle, it moves instead.',
      gait: WALK,
      seconds: 2.2,
    },
    {
      label: 'dropping into a crouch',
      note: 'Legs and torso lower while the guard stays up. The arms belong to the stance and the crouch supplies everything under them.',
      gait: WEAVE,
      seconds: 1.4,
    },

    {
      label: 'lead jab',
      gait: WEAVE,
      action: 'Punch_Jab',
      width: 'full',
      cancelAfter: 0.4,
      seconds: 0.45,
    },
    {
      label: 'the double',
      note: 'The same clip fired twice in a row. It should retrigger cleanly out of recovery; if it refuses, that is worth knowing.',
      gait: WEAVE,
      action: 'Punch_Jab',
      width: 'full',
      cancelAfter: 0.4,
      seconds: 0.45,
    },
    {
      label: 'cross off the double',
      gait: WEAVE,
      action: 'Punch_Cross',
      width: 'full',
      tail: 0,
    },
    {
      label: 'slipping out',
      gait: SLIP,
      seconds: 1.4,
    },

    {
      label: 'jab to set up',
      gait: WEAVE,
      action: 'Punch_Jab',
      width: 'full',
      cancelAfter: 0.4,
      seconds: 0.45,
    },
    {
      label: 'cross',
      gait: WEAVE,
      action: 'Punch_Cross',
      width: 'full',
      cancelAfter: 0.5,
      seconds: 0.55,
    },
    {
      label: 'hook to finish',
      gait: WEAVE,
      action: 'Punch_Hook',
      width: 'full',
      tail: 0,
    },
    {
      label: 'out of the hook',
      note: 'Runs straight out of the hook and straight into the weave below, so the drop and the rise are one motion.',
      gait: WEAVE,
      action: 'Punch_Hook_Rec',
      width: 'full',
      tail: 0,
    },
    {
      label: 'weaving off',
      gait: SLIP,
      seconds: 1.4,
    },

    {
      label: 'caught clean',
      note: 'Eating one. Narrow enough to leave the crouch underneath running.',
      gait: WEAVE,
      action: 'Hit_Head',
      width: 'arms',
      tail: 0,
    },
    {
      label: 'rolling out',
      gait: WALK,
      action: 'Roll',
      width: 'full',
      tail: 0,
    },
    {
      label: 'circling back',
      gait: WALK,
      seconds: 2.2,
    },

    {
      label: 'jab on the move',
      note: 'EXPERIMENT: the same punch that drifts left at `arms` width, thrown at `torso` instead. Torso adds spine and spine1, so the punch owns the lower spine rather than leaving it counter-rotating with the walk. Watch whether the fist now goes forward.',
      gait: WALK,
      action: 'Punch_Jab',
      width: 'torso',
      tail: 0,
    },
    {
      label: 'back to the middle',
      gait: WEAVE,
      seconds: 1.4,
    },

    {
      label: 'quick jab',
      note: 'EXPERIMENT: cut 0.05 tighter than the proven combination. Too early and the jab reads as a twitch.',
      gait: WEAVE,
      action: 'Punch_Jab',
      width: 'full',
      cancelAfter: 0.35,
      seconds: 0.4,
    },
    {
      label: 'quick cross',
      gait: WEAVE,
      action: 'Punch_Cross',
      width: 'full',
      cancelAfter: 0.45,
      seconds: 0.5,
    },
    {
      label: 'hook, cut in tight',
      gait: WEAVE,
      action: 'Punch_Hook',
      width: 'full',
      tail: 0,
    },
    {
      label: 'recovering',
      gait: WEAVE,
      action: 'Punch_Hook_Rec',
      width: 'full',
      tail: 0,
    },

    {
      label: 'the bell',
      note: 'The guard over a plain idle, with no crouch under it. This is the pose on its own — if it reads here it reads anywhere.',
      gait: IDLE,
      seconds: 2.6,
    },
  ],
};

export const DRILLS: readonly Drill[] = [SWORD_AND_BOARD, UNARMED, SHADOWBOX];

export function drillById(id: string): Drill | null {
  return DRILLS.find(drill => drill.id === id) ?? null;
}

/** How long a step holds, given the clip it fires. */
export function stepSeconds(step: DrillStep, clipDuration: number | null): number {
  if (step.seconds !== undefined) return step.seconds;
  if (clipDuration === null) return 2;
  return clipDuration + (step.tail ?? STEP_TAIL_SECONDS);
}
