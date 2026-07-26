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

      it('names either a real motion key or a library clip for every gait', () => {
        // Both resolve, and a gait nothing has bound yet — a crouch — is worth
        // running under an action. But a string that LOOKS like a key and is
        // not one resolves to nothing and leaves the character standing still,
        // so a mistyped key is caught here rather than noticed later.
        for (const step of drill.steps) {
          if (step.gait.startsWith('motion.')) {
            expect(ALL_MOTION_KEYS, `${drill.id}: "${step.label}" gait`).toContain(step.gait);
          } else {
            expect(step.gait.trim(), `${drill.id}: "${step.label}" gait`).not.toBe('');
          }
        }
      });

      it('a chain step names the same clip the spec has at that index', () => {
        // The `chain` field and `action` are two views of the same fact — the
        // room and the report both read `action`, `startChain`/`advanceChain`
        // both read `chain.spec`. A step whose action drifts from its own
        // spec would silently animate one clip while reporting another.
        for (const step of drill.steps) {
          if (!step.chain) continue;
          expect(step.chain.index, `${drill.id}: "${step.label}"`).toBeGreaterThanOrEqual(0);
          expect(step.chain.index, `${drill.id}: "${step.label}"`).toBeLessThan(step.chain.spec.steps.length);
          expect(
            step.chain.spec.steps[step.chain.index],
            `${drill.id}: "${step.label}" chain step`,
          ).toBe(step.action);
        }
      });

      it('every chain used by this drill actually opens somewhere in it', () => {
        // `advanceChain` only ever continues a chain that `startChain` began.
        // A spec referenced only at index > 0 would ask the controller to
        // advance something that was never started — `advanceChain` handles
        // that gracefully at runtime (see DrillStage's fallback), but a drill
        // that means to run a combo should still open every chain it uses.
        const specs = new Set(
          drill.steps.filter(step => step.chain).map(step => step.chain!.spec),
        );
        for (const spec of specs) {
          const opens = drill.steps.some(
            step => step.chain?.spec === spec && step.chain.index === 0,
          );
          expect(opens, `${drill.id}: a chain over [${spec.steps.join(', ')}] never opens`).toBe(true);
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

      it('dwells long enough on any step meant to be watched', () => {
        // A chain step is a link in a combination: it is deliberately cut
        // short, and holding it long enough to read would stop it being a
        // combination at all. Everything else has to last.
        for (const step of drill.steps) {
          if (step.chain !== undefined) continue;
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
