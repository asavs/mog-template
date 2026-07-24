/**
 * Procedural wooden action-figure body (`body.humanoid`).
 *
 * Segment meshes are children of bones (not skinned), so bone rotation moves
 * each limb piece. Bone names are the CANONICAL mog_humanoid names — PropertyBinding
 * resolves animation tracks by object name, so these must match motion tracks.
 */

import * as THREE from 'three';
import { MOG_BONES, type MogBoneId } from '../../avatar/rig';
import { registerBodyGenerator } from '../registry';
import { BODY_KEYS } from '../keys';
import { MOG_BONE_ORDER, MOG_REST_POSE } from '../restPose';
import type { ResolvedBody } from '../types';

const WOOD = 0xc4a574;
const WOOD_DARK = 0x8b6914;
const HAND_LEFT = 0xd4a574;
const HAND_RIGHT = 0xb8956a;
const HEAD_COLOR = 0xdeb887;

function matte(color: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.92,
    metalness: 0.02,
    flatShading: true,
  });
}

/** Primary child bone id for segment sizing (first child in bone order). */
function primaryChild(boneId: string): string | null {
  for (const id of MOG_BONE_ORDER) {
    if (MOG_REST_POSE.parents[id] === boneId) return id;
  }
  return null;
}

/**
 * Box spanning from the joint toward `offset`, centered halfway along it.
 * Width/depth are a fraction of length so limbs read as sticks, not cubes.
 */
function segmentMesh(
  offset: readonly [number, number, number],
  color: number,
  thicknessScale = 0.22,
): THREE.Mesh {
  const len = Math.hypot(offset[0], offset[1], offset[2]) || 0.08;
  const thick = Math.max(0.04, len * thicknessScale);
  // Default box is along Y; reorient so +Y aligns with offset.
  const geom = new THREE.BoxGeometry(thick, len, thick);
  const mesh = new THREE.Mesh(geom, matte(color));
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const dir = new THREE.Vector3(offset[0], offset[1], offset[2]);
  if (dir.lengthSq() > 1e-8) {
    dir.normalize();
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  }
  // Center of box sits halfway to the child joint.
  mesh.position.set(offset[0] * 0.5, offset[1] * 0.5, offset[2] * 0.5);
  return mesh;
}

function terminalMesh(
  size: [number, number, number],
  localOffset: [number, number, number],
  color: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), matte(color));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.position.set(...localOffset);
  return mesh;
}

function buildHumanoid(): ResolvedBody {
  const root = new THREE.Group();
  root.name = 'body.humanoid';

  const bonesById: Record<string, THREE.Bone> = {};
  const boneList: THREE.Bone[] = [];

  for (const boneId of MOG_BONE_ORDER) {
    const bone = new THREE.Bone();
    // CRITICAL: canonical scene-graph name for PropertyBinding track paths.
    bone.name = MOG_BONES[boneId as MogBoneId] ?? boneId;
    const offset = MOG_REST_POSE.offsets[boneId] ?? [0, 0, 0];
    bone.position.set(offset[0], offset[1], offset[2]);
    bonesById[boneId] = bone;
    boneList.push(bone);

    const parentId = MOG_REST_POSE.parents[boneId];
    if (parentId == null) {
      root.add(bone);
    } else {
      bonesById[parentId].add(bone);
    }
  }

  // Segment geometry: parent bone holds the mesh that spans to its child.
  for (const boneId of MOG_BONE_ORDER) {
    const bone = bonesById[boneId];
    const childId = primaryChild(boneId);

    if (boneId === 'head') {
      bone.add(terminalMesh([0.22, 0.26, 0.22], [0, 0.14, 0.02], HEAD_COLOR));
      continue;
    }
    if (boneId === 'leftHand') {
      bone.add(terminalMesh([0.08, 0.06, 0.1], [0.05, 0, 0], HAND_LEFT));
      continue;
    }
    if (boneId === 'rightHand') {
      bone.add(terminalMesh([0.08, 0.06, 0.1], [-0.05, 0, 0], HAND_RIGHT));
      continue;
    }
    if (boneId === 'leftFoot' || boneId === 'rightFoot') {
      // Ankle → toe-ish slab so the figure plants on y≈0.
      bone.add(terminalMesh([0.1, 0.05, 0.18], [0, -0.04, 0.05], WOOD_DARK));
      continue;
    }

    if (childId) {
      const childOffset = MOG_REST_POSE.offsets[childId] ?? [0, 0.1, 0];
      const isSpine =
        boneId === 'hips' ||
        boneId === 'spine' ||
        boneId === 'spine1' ||
        boneId === 'spine2' ||
        boneId === 'neck';
      const thickness = isSpine ? 0.35 : boneId.includes('Shoulder') ? 0.4 : 0.22;
      const color = boneId === 'hips' ? WOOD_DARK : WOOD;
      bone.add(segmentMesh(childOffset, color, thickness));
    }
  }

  // Pelvis block on hips for a readable torso base (hips→spine is short).
  {
    const hips = bonesById.hips;
    const pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.14, 0.16), matte(WOOD_DARK));
    pelvis.castShadow = true;
    pelvis.receiveShadow = true;
    pelvis.position.set(0, 0.02, 0);
    hips.add(pelvis);
  }

  const skeleton = new THREE.Skeleton(boneList);

  return {
    root,
    skeleton,
    bones: bonesById,
    referenceHeight: MOG_REST_POSE.referenceHeight,
  };
}

registerBodyGenerator(BODY_KEYS.humanoid, buildHumanoid);
