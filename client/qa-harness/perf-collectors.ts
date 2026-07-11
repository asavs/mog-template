/**
 * Harness-side performance instrumentation, injected into the page before any
 * app script runs (page.addInitScript). The game itself is never modified —
 * everything here observes standard browser Performance APIs and correlates
 * them to the same window.__qaPhase windows and performance.now() clock as the
 * frame trace (installCollectors in page-driver.ts).
 *
 * What is captured page-side (window.__qaPerf):
 *  - long tasks: PerformanceObserver('longtask') — any main-thread stall >50ms
 *  - memory: performance.memory.usedJSHeapSize sampled ~1/s (Chrome-only)
 * Frame deltas / percentiles are NOT captured here: they are derived at
 * report time from RunData.frames (each frame already carries t + phase), so
 * there is no second parallel per-frame trace to keep in sync.
 *
 * Resource timing is snapshotted at collection time (collectPerf), not
 * streamed, because performance.getEntriesByType('resource') already retains
 * the full timeline (buffer size is raised below).
 *
 * Budget evaluation happens after collection in run-harness.ts; this file only captures raw signals.
 */
import type { Page } from 'playwright';
import type { PerfData } from './trace-types';

/**
 * Injected into the page (serialized by Playwright — must be fully
 * self-contained, no closures over module scope). Installs the long-task
 * observer and memory sampler into window.__qaPerf. Idempotent.
 */
export function installPerfCollectors() {
  const w = window as unknown as { __qaPhase?: string; __qaPerf?: unknown };
  if (w.__qaPerf) return;

  // Memory backstops for pathological runs; never hit in a normal tens-of-
  // seconds session.
  const CAP_LONGTASK = 20000;
  const CAP_MEMORY = 4000;
  const RESOURCE_BUFFER = 5000;

  const phase = () => w.__qaPhase ?? 'startup';

  const perf = {
    perfStartedAt: performance.now(),
    longTasks: [] as Array<{ startTime: number; duration: number; phase: string; attribution: string[] }>,
    memorySamples: [] as Array<{
      t: number;
      phase: string;
      usedJSHeapSize: number;
      totalJSHeapSize: number;
      jsHeapSizeLimit: number;
    }>,
  };
  w.__qaPerf = perf;

  // Keep the full resource timeline (default cap is 250 entries, and a cold
  // load can pull far more than that between chunks, textures, and models).
  try {
    performance.setResourceTimingBufferSize(RESOURCE_BUFFER);
  } catch {
    /* not all engines allow this; the default buffer still gives a partial view */
  }

  // Long tasks: any main-thread stall >50ms. buffered:true replays tasks that
  // fired before this observer attached, so cold-load stalls are not missed.
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (perf.longTasks.length >= CAP_LONGTASK) break;
        // TaskAttributionTiming is not in the standard lib types.
        const rawAttribution =
          (entry as unknown as { attribution?: Array<Record<string, string>> }).attribution ?? [];
        const attribution = rawAttribution.map((a) =>
          [a.name, a.containerType, a.containerName, a.containerSrc].filter(Boolean).join(':'),
        );
        perf.longTasks.push({
          startTime: entry.startTime,
          duration: entry.duration,
          phase: phase(),
          attribution,
        });
      }
    });
    observer.observe({ type: 'longtask', buffered: true });
  } catch {
    /* longtask entry type unsupported — leave longTasks empty rather than throw */
  }

  // Memory: Chrome-only performance.memory, sampled once a second.
  const mem = (
    performance as unknown as {
      memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
    }
  ).memory;
  if (mem) {
    setInterval(() => {
      if (perf.memorySamples.length >= CAP_MEMORY) return;
      perf.memorySamples.push({
        t: performance.now(),
        phase: phase(),
        usedJSHeapSize: mem.usedJSHeapSize,
        totalJSHeapSize: mem.totalJSHeapSize,
        jsHeapSizeLimit: mem.jsHeapSizeLimit,
      });
    }, 1000);
  }
}

/**
 * Reads window.__qaPerf back out and snapshots the resource timeline. Call
 * once at the end of a session, before the page is closed.
 */
export async function collectPerf(page: Page): Promise<PerfData> {
  return (await page.evaluate(() => {
    type PerfInPage = {
      perfStartedAt: number;
      longTasks: Array<{ startTime: number; duration: number; phase: string; attribution: string[] }>;
      memorySamples: Array<{
        t: number;
        phase: string;
        usedJSHeapSize: number;
        totalJSHeapSize: number;
        jsHeapSizeLimit: number;
      }>;
    };

    const w = window as unknown as { __qaPerf?: PerfInPage };
    const perf: PerfInPage = w.__qaPerf ?? { perfStartedAt: 0, longTasks: [], memorySamples: [] };

    const resources = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).map((r) => ({
      name: r.name,
      initiatorType: r.initiatorType,
      transferSize: r.transferSize,
      encodedBodySize: r.encodedBodySize,
      decodedBodySize: r.decodedBodySize,
      duration: r.duration,
      startTime: r.startTime,
    }));

    return { ...perf, resources };
  })) as PerfData;
}
