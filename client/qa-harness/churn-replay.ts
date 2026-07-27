/**
 * Re-run the `input_churn` assertions over an already-recorded trace.
 *
 * The detector's thresholds get tuned; the evidence should not have to be re-gathered
 * from a live browser every time one moves. This replays `checkChurn` against any
 * `runs/*.ndjson` so a threshold change can be checked against the archived
 * before-the-fix and after-the-fix traces in seconds, and so a CI failure can be
 * re-analysed from its uploaded artifact without reproducing the run.
 *
 *   npx vite-node qa-harness/churn-replay.ts -- runs/<file>.ndjson [more.ndjson ...]
 *
 * The injected latency is recovered from the run label the sweep writes (`churn-100ms`), so
 * the `prediction-lead` sub-check that needs it is applied exactly as it was live.
 */
import path from 'node:path';
import { checkChurn, formatChurnFailures, formatChurnStats } from './input-churn';
import { readRun } from './trace-io';

/** `churn-100ms` -> 100. Anything else -> 0, which skips the latency-dependent sub-check. */
function latencyFromLabel(label: string): number {
  const match = /(?:^|-)(\d+)ms(?:$|-)/.exec(label);
  return match ? Number(match[1]) : 0;
}

function main() {
  const files = process.argv.slice(2).filter((arg) => arg.endsWith('.ndjson'));
  if (files.length === 0) {
    console.error('usage: vite-node qa-harness/churn-replay.ts -- <run.ndjson> [...]');
    process.exitCode = 1;
    return;
  }

  let ok = true;
  for (const file of files) {
    const run = readRun(path.resolve(file));
    const latencyMs = latencyFromLabel(run.meta.label);
    const { failures, stats } = checkChurn(run.frames, { latencyMs });
    console.log(`\n=== ${path.basename(file)} (${run.meta.label}, latency ${latencyMs}ms) ===`);
    if (stats.length === 0) {
      console.log('  no churn phases in this trace');
      continue;
    }
    console.log(formatChurnStats(stats));
    if (failures.length > 0) {
      ok = false;
      console.error(formatChurnFailures(run.meta.label, failures));
    } else {
      console.log('  VERDICT: clean');
    }
  }

  if (!ok) process.exitCode = 1;
}

main();
