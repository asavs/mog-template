/**
 *   npm run qa:diagnose -- qa-harness/runs/<run>.ndjson [more.ndjson...]
 *   npm run qa:diagnose -- --latest 4
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareRuns, diagnoseRun, formatDiagnostics } from './diagnostics';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = path.join(__dirname, 'runs');

function latestNdjson(n: number): string[] {
  return fs
    .readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith('.ndjson') && !f.startsWith('_'))
    .map((f) => ({ f, t: fs.statSync(path.join(RUNS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .slice(0, n)
    .map((x) => path.join(RUNS_DIR, x.f));
}

function main() {
  const argv = process.argv.slice(2);
  let files: string[] = [];
  const latestIdx = argv.indexOf('--latest');
  if (latestIdx >= 0) {
    const n = Number(argv[latestIdx + 1] ?? 6);
    files = latestNdjson(Number.isFinite(n) ? n : 6);
  } else {
    files = argv.filter((a) => !a.startsWith('-'));
  }
  if (!files.length) {
    console.error('usage: qa:diagnose -- <run.ndjson>... | --latest N');
    process.exit(1);
  }

  const reports = files.map((f) => {
    const abs = path.isAbsolute(f) ? f : path.resolve(process.cwd(), f);
    return diagnoseRun(path.basename(abs), fs.readFileSync(abs, 'utf8'));
  });

  for (const r of reports) {
    console.log(formatDiagnostics(r));
  }

  // Pair-wise same-class comparisons when we have multiples.
  const byClass = new Map<string, typeof reports>();
  for (const r of reports) {
    const cls = String(r.meta?.characterClass ?? 'unknown');
    if (!byClass.has(cls)) byClass.set(cls, []);
    byClass.get(cls)!.push(r);
  }
  console.log('\n======== cross-run reproducibility ========');
  for (const [cls, list] of byClass) {
    if (list.length < 2) {
      console.log(`${cls}: only ${list.length} run(s) — skip compare`);
      continue;
    }
    const concerns = compareRuns(list[0], list[1]);
    console.log(`${cls}: comparing ${list[0].file} vs ${list[1].file}`);
    if (!concerns.length) console.log('  stable distances / stalls across runs');
    else for (const c of concerns) console.log(`  [${c.severity}] ${c.phase}: ${c.message}`);
  }

  // Rollup
  const all = reports.flatMap((r) => r.concerns.map((c) => ({ ...c, file: r.file })));
  const crit = all.filter((c) => c.severity === 'critical' || c.severity === 'high');
  console.log('\n======== rollup ========');
  console.log(`runs=${reports.length} total_concerns=${all.length} high_or_critical=${crit.length}`);
  const byCode = new Map<string, number>();
  for (const c of all) byCode.set(c.code, (byCode.get(c.code) ?? 0) + 1);
  console.log(
    'by code:',
    [...byCode.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}×${v}`)
      .join(', ') || '(none)',
  );

  if (crit.length) process.exitCode = 1;
}

main();
