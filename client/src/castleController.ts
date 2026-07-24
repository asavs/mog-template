import * as THREE from 'three';
import { castleCollisionAsset, castleTriangleCandidates } from './castleCollision';

export const CASTLE_CAPSULE_SKIN = 0.002;
const CONTACT_EPSILON = 0.0001;
const MAX_SLIDE_ITERATIONS = 4;
const MAX_SUBSTEP_DISTANCE = 0.2;

export interface CastleMoveResult {
  position: THREE.Vector3;
  groundNormal: THREE.Vector3 | null;
}

/** Matches the Rust fixed-order broad-phase, substeps, triangle contacts, and slide projection. */
export function resolveCastleCapsuleSweep(
  current: THREE.Vector3,
  desired: THREE.Vector3,
  radius: number,
  height: number,
): CastleMoveResult {
  let position = current.clone();
  const target = desired.clone();
  let remaining = target.clone().sub(position);
  let groundNormal: THREE.Vector3 | null = null;

  for (let iteration = 0; iteration < MAX_SLIDE_ITERATIONS; iteration += 1) {
    const distance = remaining.length();
    if (distance <= CONTACT_EPSILON) break;
    const steps = THREE.MathUtils.clamp(Math.ceil(distance / MAX_SUBSTEP_DISTANCE), 1, 32);
    const start = position.clone();
    let previous = position.clone();
    let hit: { safe: THREE.Vector3; blocked: THREE.Vector3; normal: THREE.Vector3 } | null = null;
    for (let step = 1; step <= steps; step += 1) {
      const candidate = start.clone().addScaledVector(remaining, step / steps);
      const contact = capsuleContact(candidate, radius, height, remaining);
      if (contact) {
        hit = { safe: previous, blocked: candidate, normal: contact.normal };
        break;
      }
      previous = candidate;
    }
    if (!hit) {
      position = target;
      break;
    }
    let low = hit.safe;
    let high = hit.blocked;
    for (let search = 0; search < 8; search += 1) {
      const middle = low.clone().lerp(high, 0.5);
      if (capsuleContact(middle, radius, height, remaining)) high = middle;
      else low = middle;
    }
    position = low.addScaledVector(hit.normal, CASTLE_CAPSULE_SKIN);
    if (hit.normal.y > 0.35) groundNormal = hit.normal;
    remaining = target.clone().sub(position);
    const intoSurface = remaining.dot(hit.normal);
    if (intoSurface < 0) remaining.addScaledVector(hit.normal, -intoSurface);
  }
  return { position, groundNormal };
}

export function castleGroundSupport(
  position: THREE.Vector3,
  maxDistance: number,
  radius: number,
  height: number,
): THREE.Vector3 | null {
  const result = resolveCastleCapsuleSweep(
    position,
    new THREE.Vector3(position.x, position.y - maxDistance, position.z),
    radius,
    height,
  );
  return result.groundNormal && result.groundNormal.y >= 0.342 ? result.position : null;
}

function capsuleContact(position: THREE.Vector3, radius: number, height: number, motion: THREE.Vector3): { normal: THREE.Vector3 } | null {
  const asset = castleCollisionAsset();
  const start = position.clone().add(new THREE.Vector3(0, radius, 0));
  const end = position.clone().add(new THREE.Vector3(0, height - radius, 0));
  const min = start.clone().min(end).addScalar(-radius);
  const max = start.clone().max(end).addScalar(radius);
  let deepest: { normal: THREE.Vector3; penetration: number } | null = null;
  for (const triangleId of castleTriangleCandidates([min.x, min.y, min.z], [max.x, max.y, max.z])) {
    const base = triangleId * 3;
    const a = vertex(asset.vertices, asset.indices[base]);
    const b = vertex(asset.vertices, asset.indices[base + 1]);
    const c = vertex(asset.vertices, asset.indices[base + 2]);
    const [segmentPoint, trianglePoint] = closestSegmentTriangle(start, end, a, b, c);
    const delta = segmentPoint.clone().sub(trianglePoint);
    const distance = delta.length();
    const penetration = radius - distance;
    if (penetration <= CONTACT_EPSILON) continue;
    const normal = distance > CONTACT_EPSILON
      ? delta.multiplyScalar(1 / distance)
      : b.clone().sub(a).cross(c.clone().sub(a)).normalize();
    const centerDelta = start.clone().add(end).multiplyScalar(0.5).sub(a.clone().add(b).add(c).multiplyScalar(1 / 3));
    if (normal.dot(centerDelta) < 0) normal.multiplyScalar(-1);
    if (normal.lengthSq() <= CONTACT_EPSILON) normal.copy(motion).normalize().multiplyScalar(-1);
    if (!deepest || penetration > deepest.penetration) deepest = { normal, penetration };
  }
  return deepest;
}

function vertex(vertices: Float32Array, index: number): THREE.Vector3 {
  const base = index * 3;
  return new THREE.Vector3(vertices[base], vertices[base + 1], vertices[base + 2]);
}

function closestSegmentTriangle(start: THREE.Vector3, end: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
  const hit = segmentTriangleIntersection(start, end, a, b, c);
  if (hit) return [hit, hit.clone()];
  let best: [THREE.Vector3, THREE.Vector3] = [start, closestPointTriangle(start, a, b, c)];
  let bestDistance = best[0].distanceToSquared(best[1]);
  for (const point of [end]) {
    const candidate: [THREE.Vector3, THREE.Vector3] = [point, closestPointTriangle(point, a, b, c)];
    const distance = candidate[0].distanceToSquared(candidate[1]);
    if (distance < bestDistance) { best = candidate; bestDistance = distance; }
  }
  for (const [edgeStart, edgeEnd] of [[a, b], [b, c], [c, a]] as const) {
    const candidate = closestSegmentSegment(start, end, edgeStart, edgeEnd);
    const distance = candidate[0].distanceToSquared(candidate[1]);
    if (distance < bestDistance) { best = candidate; bestDistance = distance; }
  }
  return [best[0].clone(), best[1].clone()];
}

function segmentTriangleIntersection(start: THREE.Vector3, end: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): THREE.Vector3 | null {
  const normal = b.clone().sub(a).cross(c.clone().sub(a));
  const denominator = normal.dot(end.clone().sub(start));
  if (Math.abs(denominator) <= CONTACT_EPSILON) return null;
  const t = normal.dot(a.clone().sub(start)) / denominator;
  if (t < 0 || t > 1) return null;
  const point = start.clone().lerp(end, t);
  return pointInTriangle(point, a, b, c) ? point : null;
}

function pointInTriangle(point: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): boolean {
  const normal = b.clone().sub(a).cross(c.clone().sub(a));
  return b.clone().sub(a).cross(point.clone().sub(a)).dot(normal) >= -CONTACT_EPSILON
    && c.clone().sub(b).cross(point.clone().sub(b)).dot(normal) >= -CONTACT_EPSILON
    && a.clone().sub(c).cross(point.clone().sub(c)).dot(normal) >= -CONTACT_EPSILON;
}

function closestPointTriangle(point: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): THREE.Vector3 {
  const result = new THREE.Triangle(a, b, c).closestPointToPoint(point, new THREE.Vector3());
  return result;
}

function closestSegmentSegment(a0: THREE.Vector3, a1: THREE.Vector3, b0: THREE.Vector3, b1: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
  const d1 = a1.clone().sub(a0); const d2 = b1.clone().sub(b0); const r = a0.clone().sub(b0);
  const a = d1.dot(d1); const e = d2.dot(d2); const f = d2.dot(r);
  let s: number; let t: number;
  if (a <= CONTACT_EPSILON && e <= CONTACT_EPSILON) return [a0.clone(), b0.clone()];
  if (a <= CONTACT_EPSILON) { s = 0; t = THREE.MathUtils.clamp(f / e, 0, 1); }
  else {
    const c = d1.dot(r);
    if (e <= CONTACT_EPSILON) { t = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1); }
    else {
      const b = d1.dot(d2); const denominator = a * e - b * b;
      s = Math.abs(denominator) > CONTACT_EPSILON ? THREE.MathUtils.clamp((b * f - c * e) / denominator, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = THREE.MathUtils.clamp((b - c) / a, 0, 1); }
    }
  }
  return [a0.clone().addScaledVector(d1, s), b0.clone().addScaledVector(d2, t)];
}
