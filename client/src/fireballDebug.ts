type VecLike = {
  x: number;
  y: number;
  z: number;
};

type FireballDebugEntry = {
  at: number;
  event: string;
  seq: number;
  data: Record<string, unknown>;
};

export type FireballAimDebug = {
  aimDirection: ReturnType<typeof vectorDebug>;
  cameraPosition: ReturnType<typeof vectorDebug>;
  localRotationY: number;
  renderPosition: ReturnType<typeof vectorDebug>;
  targetPosition: ReturnType<typeof vectorDebug>;
};

declare global {
  interface Window {
    __fireballAimDebug?: FireballAimDebug;
    __fireballDebugConsole?: boolean;
    __fireballDebugCopy?: () => string;
    __fireballDebugDump?: () => FireballDebugEntry[];
    __fireballDebugLog?: FireballDebugEntry[];
    __fireballDebugSeq?: number;
  }
}

function round(value: number) {
  return Number.isFinite(value) ? Number(value.toFixed(3)) : value;
}

export function vectorDebug(vector: VecLike) {
  return {
    x: round(vector.x),
    y: round(vector.y),
    z: round(vector.z),
  };
}

function nextFireballDebugSeq() {
  if (typeof window === 'undefined') return 0;
  window.__fireballDebugSeq = (window.__fireballDebugSeq ?? 0) + 1;
  return window.__fireballDebugSeq;
}

export function publishFireballAimDebug(debug: FireballAimDebug) {
  if (typeof window === 'undefined') return;
  window.__fireballAimDebug = debug;
}

export function logFireballDebug(event: string, data: Record<string, unknown>) {
  if (typeof window === 'undefined') return;

  const entry: FireballDebugEntry = {
    at: round(performance.now()),
    event,
    seq: nextFireballDebugSeq(),
    data,
  };
  const log = window.__fireballDebugLog ?? [];
  log.push(entry);
  if (log.length > 300) log.splice(0, log.length - 300);
  window.__fireballDebugLog = log;
  window.__fireballDebugDump = () => [...log];
  window.__fireballDebugCopy = () => JSON.stringify(log, null, 2);

  if (window.__fireballDebugConsole !== false) {
    console.log('[FireballDebug]', JSON.stringify(entry));
  }
}
