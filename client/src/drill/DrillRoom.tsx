/**
 * The drill room — a place to refine a loadout, not to browse clips.
 *
 * The sandbox next door answers "what is this animation" one clip at a time.
 * That question is finished long before a character is. What is left is the
 * one this room asks: does this set of motions, at these widths, over these
 * gaits, with these things in its hands, hold together as somebody training.
 *
 * Three things follow from that being the question.
 *
 * TRANSPORT. A 0.43 second attack cannot be judged at full speed once. So the
 * routine can be paused, stepped, scrubbed, slowed and looped on one step, and
 * the room rather than the stage owns the cursor — which makes stepping by hand
 * and running on a timer the same mechanism.
 *
 * WIDTH IN PLACE. The width a step is scripted at is a guess until it is seen.
 * Changing it re-fires the same step immediately, so the comparison is a
 * keystroke rather than an edit-reload-find-the-step cycle.
 *
 * NOTES. Refinement that leaves no trace is just watching. Each step takes a
 * verdict and a line of prose, and they export as markdown ordered by the
 * routine, so a report reads against what actually ran.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas } from '@react-three/fiber';
import { Grid, OrbitControls, TransformControls } from '@react-three/drei';
import { Scenery } from '../stage/Scenery';
import { placementOf, sceneSource } from '../stage/placements';
import { sceneById } from '../stage/scenes';
import { DRILLS, drillById, type DrillWidth } from './drills';
import { DrillStage, type StageReport, type StepStatus } from './DrillStage';
import {
  exportNotes,
  loadNotes,
  noteKey,
  saveNotes,
  withNote,
  type Notes,
  type StepVerdict,
} from './notes';

const WIDTHS: readonly DrillWidth[] = ['full', 'torso', 'arms'];
const SPEEDS = [0.15, 0.35, 0.6, 1] as const;

/** One line naming exactly what a step runs, for the list and for a report. */
function combinationOf(step: { gait: string; action?: string; width?: DrillWidth }): string {
  const gait = step.gait.replace(/^motion\.loco_/, '');
  if (!step.action) return `${gait} · gait only`;
  return `${gait} + ${step.action} · ${step.width ?? 'full'}`;
}

export function DrillRoom() {
  const [drillId, setDrillId] = useState(DRILLS[0]?.id ?? '');
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<number>(1);
  const [widthOverride, setWidthOverride] = useState<DrillWidth | null>(null);
  const [loopStep, setLoopStep] = useState(false);
  const [replayToken, setReplayToken] = useState(0);

  const [status, setStatus] = useState<StepStatus>('ok');
  const [report, setReport] = useState<StageReport | null>(null);
  const [notes, setNotes] = useState<Notes>(() => loadNotes());
  const [exported, setExported] = useState<string | null>(null);

  // --- placing the set ------------------------------------------------------
  // The rack weapons were positioned from measured bounding boxes, which gets
  // them roughly upright and no further. Dragging them is the only way to
  // finish that, and the export is what stops the result dying on reload.
  const [placed, setPlaced] = useState<readonly (THREE.Object3D | null)[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [gizmo, setGizmo] = useState<'translate' | 'rotate'>('rotate');
  const [editing, setEditing] = useState(false);
  const [nudge, setNudge] = useState(0);

  const drill = useMemo(() => drillById(drillId), [drillId]);
  const scene = useMemo(() => sceneById(drill?.sceneId ?? ''), [drill]);
  const step = drill?.steps[index] ?? null;

  useEffect(() => saveNotes(notes), [notes]);

  const activeRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  if (!drill || !step) {
    return <main className="room"><p className="warn">No routine to run.</p></main>;
  }

  const total = drill.steps.length;
  const key = noteKey(drill.id, step.label);
  const note = notes[key] ?? {};

  const go = (next: number) => {
    setIndex(((next % total) + total) % total);
    setWidthOverride(null);
  };
  const setVerdict = (verdict: StepVerdict) => {
    setNotes(current => withNote(current, key, {
      ...note,
      verdict: note.verdict === verdict ? undefined : verdict,
    }));
  };

  return (
    <main className="room">
      <div className="room__stage">
        <Canvas shadows camera={{ position: [3.1, 1.9, 3.4], fov: 45 }}>
          <color attach="background" args={['#151821']} />
          {/* Same levels as the sandbox: these props are dark, and without the
              bounce from below the inside of a shield goes to black. */}
          <hemisphereLight intensity={1.15} color="#cfd8ee" groundColor="#2a2118" />
          <directionalLight position={[4, 8, 4]} intensity={2.2} castShadow />
          <directionalLight position={[-5, 3, -2]} intensity={0.5} color="#ffd9a8" />
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

          <Scenery
            scene={scene}
            onPlaced={(index, object) => setPlaced(current => {
              const next = [...current];
              next[index] = object;
              return next;
            })}
          />

          {editing && selected !== null && placed[selected] && (
            <TransformControls
              object={placed[selected] as THREE.Object3D}
              mode={gizmo}
              // Rotation snap is what makes a rack readable: weapons that agree
              // on an angle look racked, and weapons a degree apart look
              // dropped. Translation stays free — a grip has no natural grid.
              rotationSnap={THREE.MathUtils.degToRad(5)}
              onObjectChange={() => setNudge(value => value + 1)}
            />
          )}

          <DrillStage
            drill={drill}
            stepIndex={index}
            playing={playing}
            speed={speed}
            widthOverride={widthOverride}
            replayToken={replayToken}
            onStatus={setStatus}
            onReport={setReport}
            onElapsed={() => {
              if (loopStep) setReplayToken(token => token + 1);
              else setIndex(current => (current + 1) % total);
            }}
          />

          {/* makeDefault lets the gizmo suspend orbiting while you drag it;
              without it a drag rotates the camera and the prop at once. */}
          <OrbitControls makeDefault target={[0, 0.95, 0]} enableDamping />
        </Canvas>

        <div className="now">
          <span className="now__count">{index + 1} / {total}</span>
          <span className="now__label">{step.label}</span>
          <span className="now__combo">
            {combinationOf({ ...step, width: widthOverride ?? step.width })}
            {widthOverride && ' (overridden)'}
          </span>
          {status !== 'ok' && (
            <span className="now__warn">
              {status === 'no-clip'
                ? `no clip named ${step.action} — stage the packs, or the name is wrong`
                : 'refused: the previous action still owns the layer'}
            </span>
          )}
        </div>
      </div>

      <aside className="room__panel">
        <label className="field">
          <span>Routine</span>
          <select
            value={drillId}
            onChange={event => {
              // Restart on the way in, so a run is always the same run and a
              // step number means the same thing to both of us.
              setDrillId(event.target.value);
              setIndex(0);
              setWidthOverride(null);
            }}
          >
            {DRILLS.map(option => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </label>
        <p className="hint">{drill.note}</p>

        <h3>Transport</h3>
        <div className="row">
          <button type="button" onClick={() => go(index - 1)}>◀ prev</button>
          <button type="button" onClick={() => setPlaying(value => !value)}>
            {playing ? '❚❚ pause' : '▶ play'}
          </button>
          <button type="button" onClick={() => go(index + 1)}>next ▶</button>
          <button type="button" onClick={() => setReplayToken(token => token + 1)}>↻</button>
        </div>
        <label className="field field--check">
          <input
            type="checkbox"
            checked={loopStep}
            onChange={event => setLoopStep(event.target.checked)}
          />
          <span>Loop this step</span>
        </label>

        <div className="row row--tabs">
          {SPEEDS.map(value => (
            <button
              key={value}
              type="button"
              className={speed === value ? 'is-active' : ''}
              onClick={() => setSpeed(value)}
            >
              {value}×
            </button>
          ))}
        </div>

        <h3>Width</h3>
        <p className="hint">
          What the action claims. Changing it re-fires this step, so the three read
          back to back instead of from memory.
        </p>
        <div className="row row--tabs">
          {WIDTHS.map(value => (
            <button
              key={value}
              type="button"
              className={(widthOverride ?? step.width ?? 'full') === value ? 'is-active' : ''}
              onClick={() => setWidthOverride(value)}
            >
              {value}
            </button>
          ))}
          <button type="button" onClick={() => setWidthOverride(null)}>scripted</button>
        </div>

        <h3>This step</h3>
        {step.note && <p className="hint">{step.note}</p>}
        {report && (
          <p className={report.total > 0 && report.bound === 0 ? 'warn' : 'hint'}>
            rig {report.rig}
            {report.total > 0 && (
              <>
                <br />
                {report.bound}/{report.total} tracks bind
                {report.bound === 0 && ' — THIS CLIP MOVES NOTHING'}
                <br />
                {Object.entries(report.byBand)
                  .filter(([, count]) => count > 0)
                  .map(([band, count]) => `${band} ${count}`)
                  .join(' · ')}
              </>
            )}
          </p>
        )}

        <div className="row row--tabs">
          <button
            type="button"
            className={note.verdict === 'good' ? 'is-active' : ''}
            onClick={() => setVerdict('good')}
          >
            ok
          </button>
          <button
            type="button"
            className={note.verdict === 'needs-work' ? 'is-active' : ''}
            onClick={() => setVerdict('needs-work')}
          >
            needs work
          </button>
        </div>
        <label className="field">
          <span>Note</span>
          <textarea
            rows={3}
            value={note.text ?? ''}
            placeholder="what is wrong with it, in a sentence"
            onChange={event =>
              setNotes(current => withNote(current, key, { ...note, text: event.target.value }))}
          />
        </label>

        <h3>Set dressing</h3>
        <label className="field field--check">
          <input
            type="checkbox"
            checked={editing}
            onChange={event => setEditing(event.target.checked)}
          />
          <span>Place props by hand</span>
        </label>
        {editing && (
          <>
            <p className="hint">
              Pick a prop, drag the gizmo, then export and paste over that scene&apos;s
              <code> place</code> array in <code>stage/scenes.ts</code>. Rotation snaps to 5°.
            </p>
            <div className="row row--tabs">
              {(['rotate', 'translate'] as const).map(value => (
                <button
                  key={value}
                  type="button"
                  className={gizmo === value ? 'is-active' : ''}
                  onClick={() => setGizmo(value)}
                >
                  {value}
                </button>
              ))}
            </div>
            <ol className="props">
              {scene.place.map((placement, position) => (
                <li key={`${placement.key}-${position}`}>
                  <button
                    type="button"
                    className={selected === position ? 'is-active' : ''}
                    disabled={!placed[position]}
                    onClick={() => setSelected(selected === position ? null : position)}
                  >
                    {placement.key.replace(/^prop\./, '')}
                    {!placed[position] && ' (not loaded)'}
                  </button>
                </li>
              ))}
            </ol>
            {selected !== null && placed[selected] && (
              <p className="hint">
                {/* `nudge` is read here so the readout re-renders while dragging. */}
                <code data-nudge={nudge}>
                  {JSON.stringify(
                    placementOf(scene.place[selected].key, placed[selected] as THREE.Object3D),
                  )}
                </code>
              </p>
            )}
            <div className="row">
              <button
                type="button"
                onClick={() => setExported(sceneSource(
                  scene.place.map((placement, position) => {
                    const object = placed[position];
                    return object ? placementOf(placement.key, object) : placement;
                  }),
                ))}
              >
                Export placements
              </button>
            </div>
            <p className="hint">
              Exported absolutely, including the rack weapons that
              <code> weaponRack</code> derives from the stand — once one has been dragged, that
              relationship is no longer what put it there.
            </p>
          </>
        )}

        <h3>Routine</h3>
        <ol className="steps">
          {drill.steps.map((entry, position) => {
            const entryNote = notes[noteKey(drill.id, entry.label)];
            return (
              <li
                key={entry.label}
                ref={position === index ? activeRef : undefined}
                className={[
                  position === index ? 'is-active' : '',
                  entryNote?.verdict === 'good' ? 'is-good' : '',
                  entryNote?.verdict === 'needs-work' ? 'is-fix' : '',
                ].filter(Boolean).join(' ')}
              >
                <button type="button" onClick={() => go(position)}>
                  <span className="steps__label">{entry.label}</span>
                  <span className="steps__combo">{combinationOf(entry)}</span>
                </button>
              </li>
            );
          })}
        </ol>

        <div className="row">
          <button
            type="button"
            onClick={() => setExported(exportNotes(
              drill.id,
              drill.label,
              drill.steps.map(entry => ({
                label: entry.label,
                combination: combinationOf(entry),
              })),
              notes,
            ))}
          >
            Export notes
          </button>
        </div>
        {exported && <textarea className="export" readOnly rows={10} value={exported} />}
      </aside>
    </main>
  );
}
