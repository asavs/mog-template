/**
 * A drill is data, and data that names things wrongly fails silently.
 *
 * A mistyped gait resolves to nothing and the character stands still; a bad
 * width plays an attack at the wrong reach. Neither throws. The clip NAMES
 * cannot be checked here — the staged packs are gitignored, so CI has no
 * libraries to check against, which is why the runner reports `no-clip` on
 * screen instead. Everything that CAN be checked from the repo alone is.
 */

import { describe, expect, it } from 'vitest';
import { ALL_MOTION_KEYS, STANCES } from '../content';
import { DRILLS, stepSeconds, STEP_TAIL_SECONDS } from './drills';
import { SCENES } from '../stage/scenes';

const WIDTHS = new Set(['full', 'torso', 'arms']);

describe('drills', () => {
  it('has at least one routine', () => {
    expect(DRILLS.length).toBeGreaterThan(0);
  });

  for (const drill of DRILLS) {
    describe(drill.id, () => {
      it('runs in a scene that exists', () => {
        expect(SCENES.map(scene => scene.id)).toContain(drill.sceneId);
      });

      it('wears a stance that exists', () => {
        if (drill.stance === null) return;
        expect(Object.keys(STANCES)).toContain(drill.stance);
      });

      it('names a real motion key for every gait', () => {
        // A gait is resolved through the content seam, so it must be a KEY —
        // unlike an action, which is a library clip name.
        for (const step of drill.steps) {
          expect(ALL_MOTION_KEYS, `${drill.id}: "${step.label}" gait`).toContain(step.gait);
        }
      });

      it('uses only widths the runner understands', () => {
        for (const step of drill.steps) {
          if (step.width === undefined) continue;
          expect(WIDTHS, `${drill.id}: "${step.label}"`).toContain(step.width);
        }
      });

      it('gives every step a label, and no two the same', () => {
        const labels = drill.steps.map(step => step.label);
        for (const label of labels) expect(label.trim()).not.toBe('');
        // Steps are reported to each other by number and name; two rows called
        // the same thing makes "step 9 looks wrong" ambiguous.
        expect(new Set(labels).size).toBe(labels.length);
      });

      it('dwells long enough on every step to see it', () => {
        for (const step of drill.steps) {
          expect(stepSeconds(step, 1.2), `${drill.id}: "${step.label}"`).toBeGreaterThan(1);
        }
      });
    });
  }

  it('holds a one-shot past its end, so it settles rather than cutting away', () => {
    expect(stepSeconds({ label: 'x', gait: 'motion.loco_idle' }, 2)).toBe(2 + STEP_TAIL_SECONDS);
  });

  it('honours an explicit dwell over the clip length', () => {
    const step = { label: 'x', gait: 'motion.loco_idle', seconds: 3 };
    expect(stepSeconds(step, 99)).toBe(3);
  });

  it('still dwells when there is no clip to measure', () => {
    expect(stepSeconds({ label: 'x', gait: 'motion.loco_idle' }, null)).toBeGreaterThan(0);
  });
});
