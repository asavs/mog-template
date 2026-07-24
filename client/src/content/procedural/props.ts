/**
 * Stick-figure props sized for a 2.0-unit-tall mannequin.
 *
 * Authored in a canonical AUTHORING FRAME and know nothing about hands:
 *
 *   - origin at the grip point (where the fist closes)
 *   - +Y toward the business end — staff tip, blade point, bottle mouth, top rim
 *   - +Z out the "front" face — the shield's boss, the flat of a blade
 *
 * How that frame sits in a hand is owned by `../sockets.ts` (`GRIPS` / `applyGrip`).
 * Do not bake hand-space offsets into these generators.
 */

import * as THREE from 'three';
import { registerPropGenerator } from '../registry';
import { PROP_KEYS } from '../keys';

const WOOD = 0x8b6914;
const STEEL = 0x9aa0a6;
const LEATHER = 0x5c4033;
const GLASS = 0x6ec6ff;
const CORK = 0xc4a574;

function matte(color: number, opts?: { transparent?: boolean; opacity?: number }): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.85,
    metalness: color === STEEL ? 0.45 : 0.05,
    flatShading: true,
    transparent: opts?.transparent ?? false,
    opacity: opts?.opacity ?? 1,
  });
}

function mesh(
  geom: THREE.BufferGeometry,
  color: number,
  position: [number, number, number],
  opts?: { transparent?: boolean; opacity?: number },
): THREE.Mesh {
  const m = new THREE.Mesh(geom, matte(color, opts));
  m.castShadow = true;
  m.position.set(...position);
  return m;
}

function makeStaff(): THREE.Object3D {
  const root = new THREE.Group();
  root.name = 'prop.staff';
  // Grip at origin. Majority of length is +Y (business end / tip).
  // A short −Y riser (~0.18) gives a walking-staff crown above the hand without
  // enough reverse length to read as "through the torso" on a forward thrust.
  root.add(mesh(new THREE.CylinderGeometry(0.03, 0.035, 1.2, 6), WOOD, [0, 0.42, 0]));
  root.add(mesh(new THREE.CylinderGeometry(0.034, 0.03, 0.1, 6), LEATHER, [0, 0.02, 0]));
  root.add(mesh(new THREE.SphereGeometry(0.05, 6, 6), WOOD, [0, -0.18, 0])); // crown / butt
  root.add(mesh(new THREE.SphereGeometry(0.045, 6, 6), WOOD, [0, 1.05, 0])); // tip
  return root;
}

function makeSword(): THREE.Object3D {
  const root = new THREE.Group();
  root.name = 'prop.sword';
  // Grip at origin, blade along +Y, flat of the blade faces +Z.
  // Pommel is short on −Y so it stays in the palm instead of running up the forearm.
  root.add(mesh(new THREE.CylinderGeometry(0.025, 0.028, 0.12, 6), LEATHER, [0, 0.04, 0]));
  root.add(mesh(new THREE.SphereGeometry(0.028, 5, 5), STEEL, [0, -0.04, 0]));
  root.add(mesh(new THREE.BoxGeometry(0.18, 0.03, 0.04), STEEL, [0, 0.11, 0]));
  root.add(mesh(new THREE.BoxGeometry(0.05, 0.62, 0.02), STEEL, [0, 0.45, 0]));
  root.add(mesh(new THREE.BoxGeometry(0.04, 0.08, 0.02), STEEL, [0, 0.79, 0]));
  return root;
}

function makeShield(): THREE.Object3D {
  const root = new THREE.Group();
  root.name = 'prop.shield';
  // Handle / strap seat at the origin. Disc in the XY plane: face normal +Z
  // (boss out the front), top rim toward +Y.
  const disc = mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.05, 10), STEEL, [0, 0, 0]);
  // Cylinder default axis is Y; tip it so thickness runs along Z.
  disc.rotation.x = Math.PI / 2;
  root.add(disc);
  // Boss on the front face.
  root.add(mesh(new THREE.SphereGeometry(0.06, 6, 6), STEEL, [0, 0, 0.04]));
  // Strap block on the back (−Z), centred on the grip.
  root.add(mesh(new THREE.BoxGeometry(0.08, 0.1, 0.06), LEATHER, [0, 0, -0.04]));
  return root;
}

function makePotion(): THREE.Object3D {
  const root = new THREE.Group();
  root.name = 'prop.potion';
  // Bottle along +Y; mouth is the business end.
  root.add(
    mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.12, 8), GLASS, [0, 0.04, 0], {
      transparent: true,
      opacity: 0.75,
    }),
  );
  root.add(mesh(new THREE.CylinderGeometry(0.02, 0.025, 0.05, 6), GLASS, [0, 0.12, 0]));
  root.add(mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.02, 6), CORK, [0, 0.155, 0]));
  return root;
}

registerPropGenerator(PROP_KEYS.staff, makeStaff);
registerPropGenerator(PROP_KEYS.sword, makeSword);
registerPropGenerator(PROP_KEYS.shield, makeShield);
registerPropGenerator(PROP_KEYS.potion, makePotion);
