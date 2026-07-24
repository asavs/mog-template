/**
 * Sandbox scene and controls.
 *
 * The scene is deliberately plain — flat ground, neutral light, orbit camera —
 * so nothing competes with the motion being judged.
 *
 * Locomotion, stance, and action are separate controls on purpose. An action
 * plays as an overlay over whatever the legs are doing, so you can run, hold a
 * staff, and throw at the same time and watch the layering work. The movement
 * slider is the interesting one: at 0 the action owns the whole torso, above 0
 * it is confined to the arms so the gait underneath still reads.
 */

import { useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { Grid, OrbitControls } from '@react-three/drei';
import {
  ALL_PROP_KEYS,
  ALL_STANCE_KEYS,
  contentSeamReport,
  MOTION_ACTION,
  MOTION_AIR,
  MOTION_LOCOMOTION,
  MOTION_REACTION,
  STANCE_KEYS,
  STANCES,
  type MotionKey,
  type PropKey,
  type StanceKey,
} from '../content';
import { SandboxAvatar, type SandboxTrigger } from './SandboxAvatar';

const NO_PROP = 'none' as const;
type PropChoice = PropKey | typeof NO_PROP;

const LOCOMOTION_OPTIONS: readonly MotionKey[] = Object.values(MOTION_LOCOMOTION);

const OVERLAY_ABILITIES: readonly MotionKey[] = [
  MOTION_ACTION.hurl1h,
  MOTION_ACTION.slam2h,
  MOTION_ACTION.swing1h,
  MOTION_ACTION.drink,
];

const shortName = (key: string) => key.replace(/^(motion|prop)\./, '');

export function Sandbox() {
  const [locomotion, setLocomotion] = useState<MotionKey>(MOTION_LOCOMOTION.idle);
  const [stance, setStance] = useState<StanceKey>(STANCE_KEYS.unarmed);
  const [ability, setAbility] = useState<MotionKey>(MOTION_ACTION.hurl1h);
  const [movement, setMovement] = useState(0);
  const [gripTest, setGripTest] = useState<PropChoice>(NO_PROP);
  const [guard, setGuard] = useState(false);
  const [trigger, setTrigger] = useState<SandboxTrigger | null>(null);
  const [showSeam, setShowSeam] = useState(true);
  const [rigReport, setRigReport] = useState<string[]>([]);

  const seam = useMemo(() => contentSeamReport(), []);
  const placeholderCount = seam.filter(binding => binding.origin === 'procedural').length;
  const unboundCount = seam.filter(binding => binding.origin === 'unbound').length;

  const fire = (key: MotionKey, kind: SandboxTrigger['kind']) =>
    setTrigger(previous => ({
      key,
      kind,
      movement,
      nonce: (previous?.nonce ?? 0) + 1,
    }));

  return (
    <div className="sandbox">
      <Canvas shadows camera={{ position: [2.6, 1.8, 3.2], fov: 45 }}>
        <color attach="background" args={['#151821']} />
        <hemisphereLight intensity={0.6} groundColor="#0b0d12" />
        <directionalLight position={[4, 8, 4]} intensity={1.6} castShadow />

        <Grid
          args={[24, 24]}
          cellSize={0.5}
          cellColor="#2a3040"
          sectionSize={2}
          sectionColor="#39425a"
          infiniteGrid
          fadeDistance={26}
          followCamera={false}
        />
        <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
          <planeGeometry args={[40, 40]} />
          <shadowMaterial opacity={0.35} />
        </mesh>

        <SandboxAvatar
          onRigReport={setRigReport}
          locomotion={locomotion}
          stance={stance}
          guard={guard}
          gripTest={gripTest === NO_PROP ? null : gripTest}
          trigger={trigger}
        />

        <OrbitControls target={[0, 0.9, 0]} enableDamping />
      </Canvas>

      <div className="panel panel--controls">
        <h1>Animation sandbox</h1>

        <label className="field">
          <span>Locomotion (base layer)</span>
          <select
            value={locomotion}
            onChange={event => setLocomotion(event.target.value as MotionKey)}
          >
            {LOCOMOTION_OPTIONS.map(key => (
              <option key={key} value={key}>{shortName(key)}</option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Stance (loadout)</span>
          <select value={stance} onChange={event => setStance(event.target.value as StanceKey)}>
            {ALL_STANCE_KEYS.map(key => (
              <option key={key} value={key}>{STANCES[key].label}</option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Action (overlay)</span>
          <select value={ability} onChange={event => setAbility(event.target.value as MotionKey)}>
            {OVERLAY_ABILITIES.map(key => (
              <option key={key} value={key}>{shortName(key)}</option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>
            Movement while acting: {movement === 0 ? 'rooted' : `${Math.round(movement * 100)}%`}
          </span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(movement * 100)}
            onChange={event => setMovement(Number(event.target.value) / 100)}
          />
        </label>
        <p className="hint">
          {movement === 0
            ? 'Rooted — the action owns the torso from the pelvis up.'
            : 'Mobile — the action is confined to the arms so the gait still reads.'}
        </p>

        <button type="button" onClick={() => fire(ability, 'overlay')}>
          Play action
        </button>

        <label className="field field--check">
          <input
            type="checkbox"
            checked={guard}
            onChange={event => setGuard(event.target.checked)}
          />
          <span>Hold guard</span>
        </label>

        <div className="row">
          <button type="button" onClick={() => fire(MOTION_AIR.jump, 'fullBody')}>Jump</button>
          <button type="button" onClick={() => fire(MOTION_REACTION.hit, 'hit')}>Hit</button>
          <button type="button" onClick={() => fire(MOTION_REACTION.death, 'death')}>Death</button>
        </div>

        <label className="field">
          <span>Grip test (right hand)</span>
          <select value={gripTest} onChange={event => setGripTest(event.target.value as PropChoice)}>
            <option value={NO_PROP}>none</option>
            {ALL_PROP_KEYS.map(key => (
              <option key={key} value={key}>{shortName(key)}</option>
            ))}
          </select>
        </label>

        <button type="button" onClick={() => setShowSeam(value => !value)}>
          {showSeam ? 'Hide' : 'Show'} content bindings
        </button>
      </div>

      {showSeam && (
        <div className="panel panel--seam">
          <h2>Content bindings</h2>
          {rigReport.length > 0 && (
            <ul className="rig-report">
              {rigReport.map(line => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          <p className="hint">
            {placeholderCount} procedural placeholder{placeholderCount === 1 ? '' : 's'}
            {unboundCount > 0 ? `, ${unboundCount} unbound` : ''}. Drop a file named after a
            key into <code>src/content/dropin/</code> to replace it.
          </p>
          <ul>
            {seam.map(binding => (
              <li key={binding.key} className={`origin origin--${binding.origin}`}>
                <span className="origin__tag">{binding.origin}</span>
                <span className="origin__key">{binding.key}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
