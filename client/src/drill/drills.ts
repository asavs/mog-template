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
 */

import { STANCE_KEYS, type StanceKey } from '../content';

/** How much of the body an action claims. See the note above. */
export type DrillWidth = 'full' | 'torso' | 'arms';

export type DrillStep = {
  /** What this step is called, on screen and to each other. */
  label: string;
  /** What to watch for. Shown while the step runs. */
  note?: string;
  /** Motion key of the gait underneath. */
  gait: string;
  /** Library clip name to fire over it. Omitted for a step that is just a gait. */
  action?: string;
  width?: DrillWidth;
  /** Override the dwell. Defaults to the action's length plus a beat. */
  seconds?: number;
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

export const DRILLS: readonly Drill[] = [SWORD_AND_BOARD];

export function drillById(id: string): Drill | null {
  return DRILLS.find(drill => drill.id === id) ?? null;
}

/** How long a step holds, given the clip it fires. */
export function stepSeconds(step: DrillStep, clipDuration: number | null): number {
  if (step.seconds !== undefined) return step.seconds;
  if (clipDuration === null) return 2;
  return clipDuration + STEP_TAIL_SECONDS;
}
