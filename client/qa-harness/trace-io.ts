/**
 * Reading and writing run artifacts.
 *
 * The on-disk format is NDJSON (one JSON record per line): a `meta` line,
 * then `frame` and `event` records merged chronologically. One frame is one
 * line, so a 10k-frame run is ~10k greppable lines instead of a 600k-line
 * pretty-printed array, and any tool can stream it without parsing the whole
 * file. Legacy pretty-printed `.json` traces (a bare array of frames) are
 * still readable so old runs stay comparable.
 */
import fs from 'node:fs';
import path from 'node:path';
import type {
  InputEvent,
  LoadLandmarks,
  LongTaskRecord,
  MemorySample,
  PerfData,
  ResourceEntry,
  RunData,
  RunMeta,
  TraceRecord,
  WsMessageRecord,
} from './trace-types';

type NdjsonLine =
  | ({ type: 'meta' } & RunMeta)
  | ({ type: 'frame' } & TraceRecord)
  | ({ type: 'event' } & InputEvent)
  // Perf records (see perf-collectors.ts). Kept as distinct line types so the
  // file stays greppable (`grep '"type":"longtask"'`) and streamable; the
  // per-frame perf view (frame deltas) is derived from `frame` lines, not
  // stored separately.
  | { type: 'perfmeta'; perfStartedAt: number; landmarks?: LoadLandmarks }
  | ({ type: 'longtask' } & LongTaskRecord)
  | ({ type: 'memory' } & MemorySample)
  | ({ type: 'wsmessage' } & WsMessageRecord)
  | ({ type: 'resource' } & ResourceEntry);

export function writeRunNdjson(filePath: string, run: RunData): void {
  const lines: NdjsonLine[] = [{ type: 'meta', ...run.meta }];
  const merged: NdjsonLine[] = [
    ...run.frames.map((f): NdjsonLine => ({ type: 'frame', ...f })),
    ...run.events.map((e): NdjsonLine => ({ type: 'event', ...e })),
  ].sort((a, b) => (a as { t: number }).t - (b as { t: number }).t);
  lines.push(...merged);

  if (run.perf) {
    lines.push({
      type: 'perfmeta',
      perfStartedAt: run.perf.perfStartedAt,
      ...(run.perf.landmarks ? { landmarks: run.perf.landmarks } : {}),
    });
    lines.push(...run.perf.longTasks.map((lt): NdjsonLine => ({ type: 'longtask', ...lt })));
    lines.push(...run.perf.memorySamples.map((m): NdjsonLine => ({ type: 'memory', ...m })));
    lines.push(...run.perf.wsMessages.map((m): NdjsonLine => ({ type: 'wsmessage', ...m })));
    lines.push(...run.perf.resources.map((r): NdjsonLine => ({ type: 'resource', ...r })));
  }

  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

export function writeFramesCsv(filePath: string, frames: TraceRecord[]): void {
  // Channel columns are dynamic — whatever keys the client published.
  const channelKeys = [...new Set(frames.flatMap((r) => Object.keys(r.channels ?? {})))].sort();

  const header = [
    't', 'phase',
    'simX', 'simY', 'simZ',
    'renderX', 'renderY', 'renderZ',
    'offsetX', 'offsetY', 'offsetZ', 'offsetLength',
    'camX', 'camY', 'camZ',
    'localServerTick', 'localCorrectionError',
    ...channelKeys.map((k) => `ch_${k}`),
  ];
  const rows = frames.map((r) => [
    r.t.toFixed(3), r.phase,
    r.simPosition?.x ?? '', r.simPosition?.y ?? '', r.simPosition?.z ?? '',
    r.renderPosition?.x ?? '', r.renderPosition?.y ?? '', r.renderPosition?.z ?? '',
    r.visualOffset?.x ?? '', r.visualOffset?.y ?? '', r.visualOffset?.z ?? '', r.offsetLength ?? '',
    r.cameraPosition?.x ?? '', r.cameraPosition?.y ?? '', r.cameraPosition?.z ?? '',
    r.localServerTick ?? '', r.localCorrectionError ?? '',
    ...channelKeys.map((k) => r.channels?.[k] ?? ''),
  ].join(','));
  fs.writeFileSync(filePath, [header.join(','), ...rows].join('\n'));
}

/**
 * Reads a run from disk — `.ndjson` (current format) or a legacy `.json`
 * frame array, for which meta is reconstructed from the filename
 * (`<stamp>-<label>-<class>.json`) and phase-transition events are
 * synthesized from the frames so reports still get phase boundaries.
 */
export function readRun(filePath: string): RunData {
  const raw = fs.readFileSync(filePath, 'utf8');
  if (raw.trimStart().startsWith('[')) return readLegacyJson(filePath, raw);

  const stripType = <T extends { type: string }>(rec: T): Omit<T, 'type'> => {
    const copy: Record<string, unknown> = { ...rec };
    delete copy.type;
    return copy as Omit<T, 'type'>;
  };

  let meta: RunMeta | null = null;
  const frames: TraceRecord[] = [];
  const events: InputEvent[] = [];
  let perf: PerfData | null = null;
  const ensurePerf = (): PerfData => {
    if (!perf) perf = { perfStartedAt: 0, longTasks: [], memorySamples: [], wsMessages: [], resources: [] };
    return perf;
  };
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as NdjsonLine;
    switch (rec.type) {
      case 'meta':
        meta = stripType(rec);
        break;
      case 'frame':
        frames.push(stripType(rec));
        break;
      case 'perfmeta': {
        const p = ensurePerf();
        p.perfStartedAt = rec.perfStartedAt;
        if (rec.landmarks) p.landmarks = rec.landmarks;
        break;
      }
      case 'longtask':
        ensurePerf().longTasks.push(stripType(rec));
        break;
      case 'memory':
        ensurePerf().memorySamples.push(stripType(rec));
        break;
      case 'wsmessage':
        ensurePerf().wsMessages.push(stripType(rec));
        break;
      case 'resource':
        ensurePerf().resources.push(stripType(rec));
        break;
      default:
        events.push(stripType(rec));
    }
  }
  if (!meta) throw new Error(`${filePath}: no meta record found`);
  return { meta, frames, events, ...(perf ? { perf } : {}) };
}

function readLegacyJson(filePath: string, raw: string): RunData {
  const frames = JSON.parse(raw) as TraceRecord[];
  const base = path.basename(filePath, path.extname(filePath));
  // <ISO stamp with : and . replaced by ->-<label>-<class>; the stamp is the
  // first 24 chars, the class is the last dash segment.
  const rest = base.slice(25);
  const characterClass = rest.slice(rest.lastIndexOf('-') + 1) || 'unknown';
  const label = rest.slice(0, rest.lastIndexOf('-')) || rest;

  const events: InputEvent[] = [];
  let prevPhase: string | null = null;
  for (const f of frames) {
    if (f.phase !== prevPhase) {
      events.push({ t: f.t, kind: 'phase', detail: f.phase });
      prevPhase = f.phase;
    }
  }

  return {
    meta: { version: 2, characterClass, label, startedAt: base.slice(0, 24), clientUrl: '' },
    frames,
    events,
  };
}
