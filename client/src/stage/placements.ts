/**
 * Reading a placement back off the thing you just dragged.
 *
 * A gizmo is only half a tool. Nudging a sword until it sits right in a rack is
 * worth nothing if the numbers live in the browser and die on reload — so the
 * other half is turning the object's transform back into the source literal
 * that put it there, ready to paste into `scenes.ts`.
 *
 * This is the same shape the sandbox and the drill room already use for
 * judgement: work in the browser, export the decision, commit the export.
 */

import * as THREE from 'three';
import type { Placement } from './scenes';

/** Enough precision to place a prop, few enough digits to read. */
function round(value: number, places = 2): number {
  const factor = 10 ** places;
  // `+0` rather than `-0`, which is what negative rounding otherwise produces
  // and which then prints as "-0" in the exported source.
  return (Math.round(value * factor) + 0) / factor;
}

const degrees = (radians: number) => round(THREE.MathUtils.radToDeg(radians), 1);

/**
 * The placement an object currently represents.
 *
 * Emits `turn` when the object is only yawed, and the full `rotate` triple when
 * it is not — matching how the scenes are authored by hand, where scenery
 * standing on its base only ever needs turning and a weapon hanging from its
 * grip needs tipping as well.
 */
export function placementOf(key: string, object: THREE.Object3D): Placement {
  const at: [number, number, number] = [
    round(object.position.x),
    round(object.position.y),
    round(object.position.z),
  ];
  const euler = new THREE.Euler().setFromQuaternion(object.quaternion, 'XYZ');
  const rotate: [number, number, number] = [
    degrees(euler.x),
    degrees(euler.y),
    degrees(euler.z),
  ];
  const scale = round(object.scale.x, 3);

  const placement: Placement = { key, at };
  if (rotate[0] === 0 && rotate[2] === 0) {
    if (rotate[1] !== 0) return { ...placement, ...(scale === 1 ? {} : { scale }), turn: rotate[1] };
    return scale === 1 ? placement : { ...placement, scale };
  }
  return { ...placement, rotate, ...(scale === 1 ? {} : { scale }) };
}

const triple = (values: readonly number[]) => `[${values.join(', ')}]`;

/** One placement as the source line that would produce it. */
export function placementSource(placement: Placement): string {
  const parts = [`key: '${placement.key}'`, `at: ${triple(placement.at)}`];
  if (placement.rotate) parts.push(`rotate: ${triple(placement.rotate)}`);
  else if (placement.turn !== undefined) parts.push(`turn: ${placement.turn}`);
  if (placement.scale !== undefined) parts.push(`scale: ${placement.scale}`);
  return `      { ${parts.join(', ')} },`;
}

/**
 * A whole scene's `place` array, as source.
 *
 * Absolute, always — even for props a helper positioned relative to something
 * else. `weaponRack` derives its weapons from the stand's own transform, and
 * once you have dragged one of them by hand that relationship is no longer what
 * put it there. Saying so in the output is better than emitting offsets that
 * quietly disagree with where the thing actually is.
 */
export function sceneSource(placements: readonly Placement[]): string {
  return [
    '    place: [',
    ...placements.map(placementSource),
    '    ],',
  ].join('\n');
}
