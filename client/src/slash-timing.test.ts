import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { ATTACK_ANIMATION_TIME_SCALE, PALADIN_SLASH_ANIMATION_PATH } from './combatTiming';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(CLIENT_ROOT, '..');

function readRustFloatConstant(filePath: string, name: string) {
  const source = fs.readFileSync(filePath, 'utf8');
  const match = source.match(new RegExp(`const\\s+${name}:\\s+f32\\s*=\\s*([0-9.]+);`));
  if (!match) {
    throw new Error(`Could not find Rust f32 constant ${name} in ${filePath}`);
  }
  return Number(match[1]);
}

function loadSlashClip() {
  const assetPath = path.join(CLIENT_ROOT, 'public', PALADIN_SLASH_ANIMATION_PATH.replace(/^\//, ''));
  const data = fs.readFileSync(assetPath);
  const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const object = new FBXLoader().parse(arrayBuffer, '/models/paladin/');
  const [clip] = object.animations;
  if (!clip) {
    throw new Error(`No animation clip found in ${assetPath}`);
  }
  return clip;
}

function peakAngularVelocityTime(clip: THREE.AnimationClip, trackName: string) {
  const track = clip.tracks.find(candidate => candidate.name === trackName);
  if (!track) {
    throw new Error(`No animation track named ${trackName}`);
  }

  let peakTime = 0;
  let peakVelocity = 0;
  for (let index = 1; index < track.times.length; index += 1) {
    const previousOffset = (index - 1) * 4;
    const currentOffset = index * 4;
    const previous = new THREE.Quaternion(
      track.values[previousOffset],
      track.values[previousOffset + 1],
      track.values[previousOffset + 2],
      track.values[previousOffset + 3],
    );
    const current = new THREE.Quaternion(
      track.values[currentOffset],
      track.values[currentOffset + 1],
      track.values[currentOffset + 2],
      track.values[currentOffset + 3],
    );
    const deltaSeconds = track.times[index] - track.times[index - 1];
    const velocity = previous.angleTo(current) / deltaSeconds;
    if (velocity > peakVelocity) {
      peakVelocity = velocity;
      peakTime = (track.times[index] + track.times[index - 1]) / 2;
    }
  }

  return peakTime;
}

describe('paladin slash timing contract', () => {
  it('keeps server impact near the measured sword-hand contact motion', () => {
    const serverPath = path.join(REPO_ROOT, 'server/spacetimedb/src/lib.rs');
    const impactDelaySeconds = readRustFloatConstant(serverPath, 'SLASH_IMPACT_DELAY_SECONDS');

    const slashClip = loadSlashClip();
    const rightHandPeak = peakAngularVelocityTime(
      slashClip,
      'mixamorigRightHand.quaternion',
    ) / ATTACK_ANIMATION_TIME_SCALE;

    expect(impactDelaySeconds).toBeGreaterThan(0);
    expect(Math.abs(impactDelaySeconds - rightHandPeak)).toBeLessThanOrEqual(0.08);
  });

  it('keeps windup, contact, and recovery inside the visible slash animation window', () => {
    const serverPath = path.join(REPO_ROOT, 'server/spacetimedb/src/lib.rs');
    const impactDelaySeconds = readRustFloatConstant(serverPath, 'SLASH_IMPACT_DELAY_SECONDS');
    const cooldownSeconds = readRustFloatConstant(serverPath, 'SLASH_COOLDOWN_SECONDS');

    const slashClip = loadSlashClip();
    const effectiveClipSeconds = slashClip.duration / ATTACK_ANIMATION_TIME_SCALE;
    const recoverySeconds = cooldownSeconds - impactDelaySeconds;

    expect(impactDelaySeconds).toBeGreaterThan(0);
    expect(recoverySeconds).toBeGreaterThan(0);
    expect(cooldownSeconds).toBeGreaterThanOrEqual(effectiveClipSeconds);
    expect(cooldownSeconds - effectiveClipSeconds).toBeLessThanOrEqual(0.15);
  });
});
