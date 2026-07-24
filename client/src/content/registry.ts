/**
 * Procedural generator registry.
 *
 * Placeholder content is code, not files. Generators register here under an id
 * that a manifest binding points at. The resolver treats a generator and an
 * asset file as interchangeable sources for the same key.
 */

import type { BodyGenerator, MotionGenerator, PropGenerator } from './types';

const motionGenerators = new Map<string, MotionGenerator>();
const bodyGenerators = new Map<string, BodyGenerator>();
const propGenerators = new Map<string, PropGenerator>();

export function registerMotionGenerator(id: string, generator: MotionGenerator): void {
  motionGenerators.set(id, generator);
}

export function registerBodyGenerator(id: string, generator: BodyGenerator): void {
  bodyGenerators.set(id, generator);
}

export function registerPropGenerator(id: string, generator: PropGenerator): void {
  propGenerators.set(id, generator);
}

export function getMotionGenerator(id: string): MotionGenerator | undefined {
  return motionGenerators.get(id);
}

export function getBodyGenerator(id: string): BodyGenerator | undefined {
  return bodyGenerators.get(id);
}

export function getPropGenerator(id: string): PropGenerator | undefined {
  return propGenerators.get(id);
}

/** Registered generator ids, for diagnostics and the seam report. */
export function registeredGeneratorIds(): {
  motion: string[];
  body: string[];
  prop: string[];
} {
  return {
    motion: [...motionGenerators.keys()].sort(),
    body: [...bodyGenerators.keys()].sort(),
    prop: [...propGenerators.keys()].sort(),
  };
}
