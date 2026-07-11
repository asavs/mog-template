import * as THREE from 'three';
import { SOUND_REGISTRY, type SoundId } from './soundRegistry';

const audioLoader = new THREE.AudioLoader();
const bufferCache = new Map<string, Promise<AudioBuffer>>();
const listenerLocalPosition = new THREE.Vector3();
// Fire-and-forget one-shot sounds, tracked so we can stop them the instant the
// world unmounts instead of leaving them to their individual cleanup timers.
const activeSounds = new Set<THREE.Audio | THREE.PositionalAudio>();
const activeSoundTimeouts = new Map<THREE.Audio | THREE.PositionalAudio, number>();

let listener: THREE.AudioListener | null = null;
let activeCamera: THREE.Camera | null = null;
let activeWorldRoot: THREE.Object3D | null = null;
let audioUnlocked = false;
let gameAudioMuted = false;
// Bumped on every attach/detach so an async buffer load that resolves after the
// world it was started in has torn down can tell it's stale and bail — even if a
// new world has since mounted and re-populated activeCamera.
let activeSessionId = 0;

function getAudioContext() {
  return THREE.AudioContext.getContext() as unknown as globalThis.AudioContext;
}

function loadBuffer(soundId: SoundId) {
  const { url } = SOUND_REGISTRY[soundId];
  const cached = bufferCache.get(url);
  if (cached) return cached;

  // Evict the entry if the load fails so a transient failure doesn't
  // permanently poison this sound with a cached rejected promise.
  const promise = audioLoader.loadAsync(url).catch(error => {
    bufferCache.delete(url);
    throw error;
  });
  bufferCache.set(url, promise);
  return promise;
}

export function getAudioListener() {
  listener ??= new THREE.AudioListener();
  listener.setMasterVolume(gameAudioMuted ? 0 : 1);
  return listener;
}

export function setGameAudioMuted(muted: boolean) {
  gameAudioMuted = muted;
  listener?.setMasterVolume(muted ? 0 : 1);
}

export function attachAudioListener(camera: THREE.Camera, worldRoot?: THREE.Object3D) {
  activeSessionId++;
  const audioListener = getAudioListener();
  activeWorldRoot = worldRoot ?? activeWorldRoot;
  if (activeCamera === camera && camera.children.includes(audioListener)) return audioListener;

  audioListener.removeFromParent();
  camera.add(audioListener);
  activeCamera = camera;
  return audioListener;
}

// Detach on world unmount so the module stops retaining the camera and scene.
// The listener singleton is reused, so we only drop it from its parent rather
// than discarding it.
export function detachAudioListener() {
  activeSessionId++;
  listener?.removeFromParent();
  activeCamera = null;
  activeWorldRoot = null;
  for (const audio of [...activeSounds]) {
    stopManagedAudio(audio);
  }
}

export function setAudioListenerWorldPosition(position: THREE.Vector3) {
  if (!listener || !activeCamera) return;

  activeCamera.updateMatrixWorld();
  listenerLocalPosition.copy(position);
  activeCamera.worldToLocal(listenerLocalPosition);
  listener.position.copy(listenerLocalPosition);
}

export function unlockGameAudio() {
  if (audioUnlocked) return;

  const context = getAudioContext();
  if (context.state === 'suspended') {
    context.resume().catch(() => {});
  }
  audioUnlocked = true;
}

export function installAudioUnlockHandlers() {
  const unlock = () => unlockGameAudio();
  window.addEventListener('pointerdown', unlock, { once: true, capture: true });
  window.addEventListener('keydown', unlock, { once: true, capture: true });
  return () => {
    window.removeEventListener('pointerdown', unlock, { capture: true });
    window.removeEventListener('keydown', unlock, { capture: true });
  };
}

function applyPositionalSettings(audio: THREE.PositionalAudio, soundId: SoundId) {
  const config = SOUND_REGISTRY[soundId];
  audio.setVolume(config.worldVolume ?? config.volume);
  audio.setRefDistance(config.refDistance ?? 1);
  audio.setMaxDistance(config.maxDistance ?? 10000);
  audio.setRolloffFactor(config.rolloffFactor ?? 1);
  audio.setDistanceModel(config.distanceModel ?? 'inverse');
  audio.panner.panningModel = 'HRTF';
}

export async function playLocalSound(soundId: SoundId) {
  const sessionId = activeSessionId;
  const audioListener = getAudioListener();
  const buffer = await loadBuffer(soundId);
  // The world may have unmounted (or unmounted and a new one remounted) while the
  // buffer was loading; don't play into a dead or different session (avoids a
  // fireball firing off in the menu, or in the next match at stale coordinates).
  if (sessionId !== activeSessionId || !activeCamera) return;

  const audio = new THREE.Audio(audioListener);
  audio.setBuffer(buffer);
  audio.setVolume(SOUND_REGISTRY[soundId].volume);
  scheduleOneShotCleanup(audio, buffer.duration);
  audio.play();
}

export async function playWorldSound(soundId: SoundId, position: THREE.Vector3) {
  const sessionId = activeSessionId;
  const audioListener = getAudioListener();
  const config = SOUND_REGISTRY[soundId];
  const listenerPosition = new THREE.Vector3();
  audioListener.getWorldPosition(listenerPosition);
  if (config.maxDistance !== undefined && listenerPosition.distanceTo(position) > config.maxDistance) {
    return;
  }

  const buffer = await loadBuffer(soundId);
  // Bail if the world unmounted (or remounted as a new session) mid-load,
  // otherwise this attaches to a stale camera/scene and plays a ghost sound in
  // the menu or the next match.
  if (sessionId !== activeSessionId || !activeCamera) return;

  const audio = new THREE.PositionalAudio(audioListener);
  applyPositionalSettings(audio, soundId);
  audio.setBuffer(buffer);
  audio.position.copy(position);
  activeWorldRoot?.add(audio);
  if (!audio.parent && activeCamera) {
    activeCamera.updateMatrixWorld();
    activeCamera.worldToLocal(audio.position);
    activeCamera.add(audio);
  }
  scheduleOneShotCleanup(audio, buffer.duration);
  audio.play();
}

export async function createLoopingLocalSound(soundId: SoundId) {
  const audioListener = getAudioListener();
  const buffer = await loadBuffer(soundId);
  const audio = new THREE.Audio(audioListener);
  audio.setBuffer(buffer);
  audio.setLoop(true);
  audio.setVolume(SOUND_REGISTRY[soundId].volume);
  return audio;
}

export async function createLoopingWorldSound(soundId: SoundId) {
  const audioListener = getAudioListener();
  const buffer = await loadBuffer(soundId);
  const audio = new THREE.PositionalAudio(audioListener);
  applyPositionalSettings(audio, soundId);
  audio.setBuffer(buffer);
  audio.setLoop(true);
  return audio;
}

// Track a one-shot so it can be stopped on unmount, and schedule its own
// disposal a little past its duration. The timeout id is tracked so stopping the
// sound early can cancel it rather than leave the closure (and this audio object)
// pinned in memory until it fires.
function scheduleOneShotCleanup(audio: THREE.Audio | THREE.PositionalAudio, durationSeconds: number) {
  activeSounds.add(audio);
  const timeoutId = window.setTimeout(() => {
    stopManagedAudio(audio);
  }, durationSeconds * 1000 + 100);
  activeSoundTimeouts.set(audio, timeoutId);
}

export function stopManagedAudio(audio: THREE.Audio | THREE.PositionalAudio | null) {
  if (!audio) return;
  const timeoutId = activeSoundTimeouts.get(audio);
  if (timeoutId !== undefined) {
    window.clearTimeout(timeoutId);
    activeSoundTimeouts.delete(audio);
  }
  activeSounds.delete(audio);
  if (audio.isPlaying) audio.stop();
  audio.removeFromParent();
  audio.disconnect();
}
