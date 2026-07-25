/**
 * Animation sandbox — a clip browser, not a state machine.
 *
 * The previous version drove the runtime's vocabulary: pick a locomotion, pick
 * a stance, pick one of four actions. That shape can only ever show you clips
 * somebody already committed to, which makes "how many of these do we need?"
 * unanswerable and leaves clip names as the only available evidence. Names lie.
 *
 * This one reads the packs. Every clip in every staged library appears next to
 * the procedural placeholder it might replace, you watch it on the real body,
 * and you mark it keep or cut. The marks export as the binding table the
 * extractor consumes — so the vocabulary is an OUTPUT of looking at animations
 * rather than an input to it.
 *
 * Procedural motion is always listed, with or without packs staged. It is the
 * floor: neither library contains a single strafe, so the sideways and backward
 * gaits are procedural permanently unless we synthesise them.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas } from '@react-three/fiber';
import { Grid, OrbitControls } from '@react-three/drei';
import { OVERLAY_BANDS, type AnimationBand } from '../anim';
import {
  ALL_MOTION_KEYS,
  ALL_PROP_KEYS,
  MOTION_LOCOMOTION,
  SOCKETS,
  STANCES,
  contentSeamReport,
  type PropKey,
  type StanceKey,
} from '../content';
import { buildCatalog, type Catalog, type CatalogEntry } from './catalog';
import { DRILLS, drillById } from './drills';
import { SandboxScenery } from './SandboxScenery';
import { DEFAULT_SCENE, SCENES, sceneById } from './scenes';
import {
  SandboxStage,
  type DrillStepStatus,
  type PlaybackMode,
  type StageReport,
} from './SandboxStage';
import {
  exportBindings,
  loadMarks,
  saveMarks,
  type ExportSummary,
  type Mark,
  type Marks,
  type Verdict,
} from './verdicts';

type MaskWidth = 'full' | 'torso' | 'arms';
type SourceFilter = 'all' | 'library' | 'procedural';
type VerdictFilter = 'all' | 'unmarked' | Verdict;

const MASK_BANDS: Record<MaskWidth, readonly AnimationBand[] | null> = {
  full: null,
  torso: OVERLAY_BANDS.torso,
  arms: OVERLAY_BANDS.arms,
};

const VERDICTS: readonly Verdict[] = ['keep', 'cut', 'unsure'];
const NONE = '' as const;

/**
 * Grouped by family ACROSS libraries, not within them. UAL1 and UAL2 both ship
 * sword work and both ship melee work; which pack a clip happened to come in is
 * an accident of packaging, and splitting the sword family in two hides that
 * you are choosing between eleven sword clips rather than two and nine.
 */
type Group = { key: string; family: string; entries: CatalogEntry[] };

export function Sandbox() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [marks, setMarks] = useState<Marks>(() => loadMarks());

  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [verdictFilter, setVerdictFilter] = useState<VerdictFilter>('all');

  const [mode, setMode] = useState<PlaybackMode>('raw');
  const [loop, setLoop] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [maskWidth, setMaskWidth] = useState<MaskWidth>('full');
  const [baseLocomotion, setBaseLocomotion] = useState<string>(MOTION_LOCOMOTION.idle);
  const [stance, setStance] = useState<StanceKey | null>(null);
  const [drillId, setDrillId] = useState<string>(DRILLS[0]?.id ?? '');
  const [drillStep, setDrillStep] = useState<{ index: number; status: DrillStepStatus }>({
    index: -1,
    status: 'ok',
  });
  const [movement, setMovement] = useState(0);
  const [rightHand, setRightHand] = useState<PropKey | null>(null);
  const [leftHand, setLeftHand] = useState<PropKey | null>(null);
  const [playToken, setPlayToken] = useState(0);
  const [sceneId, setSceneId] = useState(DEFAULT_SCENE.id);

  const [report, setReport] = useState<StageReport | null>(null);
  const [exported, setExported] = useState<ExportSummary | null>(null);

  useEffect(() => {
    let disposed = false;
    void buildCatalog().then(
      built => {
        if (!disposed) setCatalog(built);
      },
      error => {
        if (!disposed) setLoadError(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      disposed = true;
    };
  }, []);

  const selected = useMemo(
    () => catalog?.entries.find(entry => entry.id === selectedId) ?? null,
    [catalog, selectedId],
  );

  const drill = useMemo(() => (mode === 'drill' ? drillById(drillId) : null), [mode, drillId]);

  // A drill brings its own set. Overriding rather than merely defaulting keeps
  // the routine reproducible — a step numbered in a report means the same thing
  // to both of us, which it would not if the room were whatever was last picked.
  const scene = useMemo(
    () => sceneById(drill?.sceneId ?? sceneId),
    [drill, sceneId],
  );

  /**
   * Every library clip by name.
   *
   * The controller resolves motions by key, and most of what a drill exercises
   * is bound to no key — the sword chain, the recoveries, the shield work. So
   * the drill reaches them by the name they carry in the pack.
   */
  const clipsByName = useMemo(() => {
    const byName = new Map<string, THREE.AnimationClip>();
    for (const entry of catalog?.entries ?? []) {
      if (entry.origin === 'library') byName.set(entry.name, entry.clip);
    }
    return byName;
  }, [catalog]);

  const currentStep = drill?.steps[drillStep.index] ?? null;

  // Keep the running step in view. Twenty-odd rows do not fit, and a routine you
  // have to scroll to follow is one you end up not reading.
  const activeStepRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    activeStepRef.current?.scrollIntoView({ block: 'nearest' });
  }, [drillStep.index]);

  // A drill fills its own hands, from the stance it wears. Judging sword work
  // with an empty fist is the mistake the prop import exists to stop.
  const drillSlots = drill?.stance ? STANCES[drill.stance].slots : [];
  const drillRightHand = drillSlots.find(slot => slot.socket === SOCKETS.rightHand)?.prop ?? null;
  const drillLeftHand = drillSlots.find(slot => slot.socket === SOCKETS.leftHand)?.prop ?? null;

  /**
   * Keys nothing resolves. Six of these are expected and deliberate — neither
   * pack ships a sideways or backward gait — but "expected" is not the same as
   * "visible", and an unbound locomotion key is a character sliding across the
   * floor in whatever pose it was last left in. Naming them here is the
   * difference between a known hole and a bug report.
   */
  const unbound = useMemo(
    () => contentSeamReport().filter(binding => binding.origin === 'unbound'),
    [],
  );

  /**
   * Which keys resolve to anything, so the gait picker can say so.
   *
   * Six of the nine locomotion keys have no clip in either library and are
   * deliberately empty. Offering them unlabelled means picking "walk left" and
   * watching the character stand still, which reads as a broken stance rather
   * than as the absent content it is.
   */
  const unboundKeys = useMemo(() => new Set(unbound.map(binding => binding.key)), [unbound]);

  const tally = useMemo(() => {
    const counts = { keep: 0, cut: 0, unsure: 0 };
    for (const mark of Object.values(marks)) counts[mark.verdict] += 1;
    return counts;
  }, [marks]);

  const groups = useMemo<Group[]>(() => {
    if (!catalog) return [];
    const needle = query.trim().toLowerCase();
    const byKey = new Map<string, Group>();

    for (const entry of catalog.entries) {
      if (sourceFilter !== 'all' && entry.origin !== sourceFilter) continue;
      if (needle && !entry.name.toLowerCase().includes(needle)) continue;
      if (verdictFilter !== 'all') {
        const mark = marks[entry.id];
        if (verdictFilter === 'unmarked' ? mark : mark?.verdict !== verdictFilter) continue;
      }

      const group = byKey.get(entry.family);
      if (group) group.entries.push(entry);
      else byKey.set(entry.family, { key: entry.family, family: entry.family, entries: [entry] });
    }

    for (const group of byKey.values()) {
      group.entries.sort((a, b) => a.name.localeCompare(b.name));
    }
    return [...byKey.values()].sort(
      (a, b) => b.entries.length - a.entries.length || a.family.localeCompare(b.family),
    );
  }, [catalog, query, sourceFilter, verdictFilter, marks]);

  const shown = groups.reduce((sum, group) => sum + group.entries.length, 0);

  const mark = (id: string, patch: Partial<Mark>) => {
    setMarks(previous => {
      // An unjudged clip defaults to `unsure`, so assigning a key before
      // marking it does not invent a verdict nobody gave.
      const existing: Mark = previous[id] ?? { verdict: 'unsure' };
      const next: Marks = { ...previous, [id]: { ...existing, ...patch } };
      saveMarks(next);
      return next;
    });
  };

  const select = (entry: CatalogEntry) => {
    setSelectedId(entry.id);
    setPlayToken(token => token + 1);
  };

  const runExport = () => {
    if (!catalog) return;
    const labels = Object.fromEntries(catalog.libraries.map(library => [library.id, library.label]));
    setExported(exportBindings(marks, catalog.entries, labels));
  };

  return (
    <div className="sandbox">
      <aside className="panel panel--browser">
        <header className="browser__head">
          <h1>Clips</h1>
          <p className="hint">
            {catalog
              ? `${shown} of ${catalog.entries.length} shown · ${tally.keep} keep, ${tally.cut} cut, ${tally.unsure} unsure`
              : loadError
                ? `catalog failed: ${loadError}`
                : 'loading…'}
          </p>
          {catalog && !catalog.staged && (
            <p className="warn">
              No animation packs staged — showing procedural only. Run{' '}
              <code>npm run assets:stage -- --source &lt;packs&gt;</code>
            </p>
          )}
          {catalog?.libraries
            .filter(library => library.state === 'error')
            .map(library => (
              <p className="warn" key={library.id}>
                {library.file} failed to load: {library.detail}
              </p>
            ))}
          {unbound.length > 0 && (
            <p className="unbound">
              <strong>{unbound.length} keys resolve to nothing:</strong>{' '}
              {unbound.map(binding => binding.key.replace(/^motion\./, '')).join(', ')}
            </p>
          )}

          <input
            className="search"
            type="search"
            placeholder="filter by name…"
            value={query}
            onChange={event => setQuery(event.target.value)}
          />
          <div className="row row--tabs">
            {(['all', 'library', 'procedural'] as const).map(value => (
              <button
                key={value}
                type="button"
                className={sourceFilter === value ? 'is-active' : ''}
                onClick={() => setSourceFilter(value)}
              >
                {value}
              </button>
            ))}
          </div>
          <div className="row row--tabs">
            {(['all', 'unmarked', 'keep', 'cut', 'unsure'] as const).map(value => (
              <button
                key={value}
                type="button"
                className={verdictFilter === value ? 'is-active' : ''}
                onClick={() => setVerdictFilter(value)}
              >
                {value}
              </button>
            ))}
          </div>
        </header>

        <div className="browser__list">
          {groups.map(group => (
            <section key={group.key} className="group">
              <h2>
                {group.family}
                <span className="group__count">{group.entries.length}</span>
              </h2>
              <ul>
                {group.entries.map(entry => {
                  const entryMark = marks[entry.id];
                  return (
                    <li key={entry.id}>
                      <button
                        type="button"
                        className={[
                          'clip',
                          selectedId === entry.id ? 'is-selected' : '',
                          entryMark ? `is-${entryMark.verdict}` : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        onClick={() => select(entry)}
                      >
                        <span className="clip__src">{entry.library ?? 'proc'}</span>
                        <span className="clip__name">{entry.name}</span>
                        <span className="clip__meta">
                          {entry.duration.toFixed(2)}s
                          {entry.motionKey && (
                            <em className={entry.active ? 'bound bound--active' : 'bound'}>
                              {entry.motionKey.replace(/^motion\./, '')}
                            </em>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      </aside>

      <Canvas shadows camera={{ position: [2.6, 1.8, 3.2], fov: 45 }}>
        <color attach="background" args={['#151821']} />
        {/*
          Lit for a room, not for a silhouette. The old levels were tuned
          against an empty grid and a plain mannequin; with textured wood and a
          wall behind, the same numbers read as murk and you cannot judge a
          pose you can barely see. The fill from below is doing real work —
          these props are dark, and without a bounce term the undersides of
          tables and the insides of a shield go to black.
        */}
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

        <SandboxScenery scene={scene} />

        <SandboxStage
          entry={selected}
          mode={mode}
          loop={loop}
          speed={speed}
          bands={MASK_BANDS[maskWidth]}
          baseLocomotion={baseLocomotion}
          stance={stance}
          drill={drill}
          clipsByName={clipsByName}
          onDrillStep={(index, status) => setDrillStep({ index, status })}
          movement={movement}
          rightHand={drill ? drillRightHand : rightHand}
          leftHand={drill ? drillLeftHand : leftHand}
          playToken={playToken}
          onReport={setReport}
        />

        <OrbitControls target={[0, 0.9, 0]} enableDamping />
      </Canvas>

      <aside className="panel panel--controls">
        <h2>{selected ? selected.name : 'nothing selected'}</h2>

        {report && (
          <p className={report.totalTracks > 0 && report.boundTracks === 0 ? 'warn' : 'hint'}>
            rig {report.rig}
            {report.clipName && (
              <>
                <br />
                {report.boundTracks}/{report.totalTracks} tracks bind
                {report.boundTracks === 0 && ' — THIS CLIP MOVES NOTHING'}
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
          {(['raw', 'layered', 'drill'] as const).map(value => (
            <button
              key={value}
              type="button"
              className={mode === value ? 'is-active' : ''}
              onClick={() => setMode(value)}
            >
              {value}
            </button>
          ))}
        </div>
        <p className="hint">
          {mode === 'raw'
            && 'Clip alone, no rules, no gait underneath. What IS this animation.'}
          {mode === 'layered'
            && 'Through the real controller, over a gait. Does it still read.'}
          {mode === 'drill'
            && 'A scripted routine through everything a loadout needs. Does the set hold together.'}
        </p>

        {mode === 'drill' && (
          <>
            <label className="field">
              <span>Routine</span>
              <select value={drillId} onChange={event => setDrillId(event.target.value)}>
                {DRILLS.map(option => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            {drill && (
              <>
                <p className="hint">{drill.note}</p>
                <ol className="drill">
                  {drill.steps.map((step, index) => (
                    <li
                      key={`${step.label}-${index}`}
                      ref={index === drillStep.index ? activeStepRef : undefined}
                      className={index === drillStep.index ? 'is-active' : ''}
                    >
                      <span className="drill__label">{step.label}</span>
                      <span className="drill__combo">
                        {step.gait.replace(/^motion\.loco_/, '')}
                        {step.action ? ` + ${step.action} · ${step.width ?? 'full'}` : ' · gait only'}
                      </span>
                    </li>
                  ))}
                </ol>
                {currentStep && (
                  <p className={drillStep.status === 'ok' ? 'hint' : 'warn'}>
                    {drillStep.status === 'ok'
                      && (currentStep.note
                        ?? `step ${drillStep.index + 1} of ${drill.steps.length}`)}
                    {drillStep.status === 'no-clip'
                      && `step ${drillStep.index + 1}: no clip named ${currentStep.action} — `
                        + 'the pack is not staged, or the name is wrong. Nothing is playing.'}
                    {drillStep.status === 'refused'
                      && `step ${drillStep.index + 1} was REFUSED — the layer was still owned by `
                        + 'the previous action, so what you are watching is that one.'}
                  </p>
                )}
              </>
            )}
          </>
        )}

        <div className="row">
          <button type="button" onClick={() => setPlayToken(token => token + 1)}>
            Replay
          </button>
          <label className="field field--check">
            <input type="checkbox" checked={loop} onChange={e => setLoop(e.target.checked)} />
            <span>Loop</span>
          </label>
        </div>

        <label className="field">
          <span>Speed {speed.toFixed(2)}×</span>
          <input
            type="range"
            min={10}
            max={200}
            step={5}
            value={Math.round(speed * 100)}
            onChange={event => setSpeed(Number(event.target.value) / 100)}
          />
        </label>

        <label className="field">
          <span>Mask</span>
          <select value={maskWidth} onChange={e => setMaskWidth(e.target.value as MaskWidth)}>
            <option value="full">full body</option>
            <option value="torso">torso (mid + upper)</option>
            <option value="arms">arms (upper only)</option>
          </select>
        </label>

        {mode === 'layered' && (
          <>
            <label className="field">
              <span>Gait underneath</span>
              <select value={baseLocomotion} onChange={e => setBaseLocomotion(e.target.value)}>
                {Object.values(MOTION_LOCOMOTION).map(key => (
                  <option key={key} value={key}>
                    {key.replace(/^motion\./, '')}
                    {unboundKeys.has(key) ? ' — no clip' : ''}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Stance</span>
              <select
                value={stance ?? ''}
                onChange={event => {
                  const next = (event.target.value || null) as StanceKey | null;
                  setStance(next);
                  // A stance already says what it holds, so picking one fills the
                  // hands. Judging sword-and-board with empty hands is the exact
                  // mistake the prop import was done to stop.
                  const slots = next === null ? [] : STANCES[next].slots;
                  setRightHand(slots.find(s => s.socket === SOCKETS.rightHand)?.prop ?? null);
                  setLeftHand(slots.find(s => s.socket === SOCKETS.leftHand)?.prop ?? null);
                }}
              >
                <option value="">none — locomotion&apos;s own upper body</option>
                {Object.values(STANCES).map(option => (
                  <option key={option.key} value={option.key}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            {stance !== null && STANCES[stance].poses.length > 0 && (
              <p className="hint">
                {STANCES[stance].poses
                  .map(pose => `${pose.motion.replace(/^motion\./, '')} → ${pose.bands.join('+')}`)
                  .join(' · ')}
              </p>
            )}
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
          </>
        )}

        <h3>Scene</h3>
        <label className="field">
          <select value={sceneId} onChange={event => setSceneId(event.target.value)}>
            {SCENES.map(option => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <p className="hint">{scene.note}</p>

        <h3>Hands</h3>
        <div className="row">
          {(
            [
              ['right', rightHand, setRightHand],
              ['left', leftHand, setLeftHand],
            ] as const
          ).map(([label, value, set]) => (
            <label className="field" key={label}>
              <span>{label}</span>
              <select
                value={value ?? NONE}
                onChange={event =>
                  set(event.target.value === NONE ? null : (event.target.value as PropKey))
                }
              >
                <option value={NONE}>none</option>
                {ALL_PROP_KEYS.map(key => (
                  <option key={key} value={key}>
                    {key.replace(/^prop\./, '')}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>

        <h3>Verdict</h3>
        {selected ? (
          <>
            <div className="row row--tabs">
              {VERDICTS.map(value => (
                <button
                  key={value}
                  type="button"
                  className={marks[selected.id]?.verdict === value ? 'is-active' : ''}
                  onClick={() => mark(selected.id, { verdict: value })}
                >
                  {value}
                </button>
              ))}
            </div>
            {selected.origin === 'library' ? (
              <label className="field">
                <span>Binds to motion key</span>
                <select
                  value={marks[selected.id]?.assign ?? NONE}
                  onChange={event =>
                    mark(selected.id, {
                      verdict: 'keep',
                      assign: event.target.value === NONE ? undefined : event.target.value,
                    })
                  }
                >
                  <option value={NONE}>unassigned</option>
                  {ALL_MOTION_KEYS.map(key => (
                    <option key={key} value={key}>
                      {key.replace(/^motion\./, '')}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <p className="hint">
                Generated at runtime, so there is no clip name for the binding table to point
                at. Nothing to assign.
              </p>
            )}
          </>
        ) : (
          <p className="hint">Pick a clip to judge it.</p>
        )}

        <h3>Export</h3>
        <button type="button" onClick={runExport}>
          Build binding table
        </button>
        {exported && (
          <>
            <p className="hint">
              {exported.assigned} assigned, {exported.cut} cut
              {exported.keptUnassigned.length > 0 &&
                `, ${exported.keptUnassigned.length} kept but unassigned`}
            </p>
            {exported.conflicts.map(conflict => (
              <p className="warn" key={conflict}>
                conflict — {conflict}
              </p>
            ))}
            {exported.keptUnassigned.length > 0 && (
              <p className="hint">still owed: {exported.keptUnassigned.join(', ')}</p>
            )}
            <textarea className="export" readOnly rows={12} value={exported.json} />
            <p className="hint">
              Paste over <code>src/content/clipBindings.json</code>, then re-run the extractor.
            </p>
          </>
        )}
      </aside>
    </div>
  );
}
