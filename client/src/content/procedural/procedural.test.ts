/**
 * Structural checks for procedural placeholders.
 *
 * Only the body is procedural now. The motion generators were deleted once the
 * Quaternius libraries covered their keys — see the note in `./index.ts`. The
 * checks that lived here for them (every track targets a real bone, idle does
 * not read as a T-pose) went with them; the equivalent question for imported
 * clips is asked by `inspectClipBinding` in the sandbox, against the rig that is
 * actually loaded.
 */

import { describe, expect, it } from 'vitest';
import { MOG_BONES } from '../rig';
import { BODY_KEYS } from '../keys';
import { getBodyGenerator } from '../registry';
import { MOG_REST_POSE } from '../restPose';

// Side-effect registration.
import './index';

describe('procedural body', () => {
  it('registers body.humanoid with canonical bone names', () => {
    const gen = getBodyGenerator(BODY_KEYS.humanoid);
    expect(gen).toBeTypeOf('function');

    // Named from the table every consumer looks bones up through, so the
    // placeholder and the imported rig answer to the same ids. That the
    // spelling matches shipped art is asserted by the Quaternius fixture in
    // `avatar/rig.test.ts`.
    const body = gen!();
    expect(body.bones.hips?.name).toBe(MOG_BONES.hips);
    expect(body.bones.rightHand?.name).toBe(MOG_BONES.rightHand);
    expect(body.root.getObjectByName(MOG_BONES.hips)).toBeTruthy();
    expect(body.root.getObjectByName(MOG_BONES.rightHand)).toBeTruthy();
    expect(body.skeleton.bones.length).toBeGreaterThan(0);
    expect(body.referenceHeight).toBe(MOG_REST_POSE.referenceHeight);
  });

  it('provides every bone the rig vocabulary names', () => {
    const body = getBodyGenerator(BODY_KEYS.humanoid)!();
    const present = new Set<string>();
    body.root.traverse(object => {
      if (object.name) present.add(object.name);
    });

    const missing = Object.values(MOG_BONES).filter(name => !present.has(name));
    expect(missing, `body missing ${missing.join(', ')}`).toEqual([]);
  });
});
