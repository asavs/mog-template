import type { RunData } from './trace-types';
import { summarizePerfByPhase, type PerfPhaseSummary } from './perf-stats';

export type PerfBudgetMetric =
  | 'timeToPlayableMs'
  | 'worstFrameDeltaMs'
  | 'longTaskTotalMs'
  | 'maxRemoteJumpUnits'
  | 'flickerIndex';

export type PerfBudgetFile = Record<string, Record<string, Partial<Record<PerfBudgetMetric, number>>>>;

export type PerfBudgetCheck = {
  status: 'PASS' | 'FAIL' | 'SKIP';
  name: string;
  metric?: PerfBudgetMetric;
  actual?: number;
  budget?: number;
  reason?: string;
};

const SCENARIO_BY_LABEL: Record<string, string> = {
  'perf-coldload': 'cold-load',
  'perf-firstcast': 'first-cast',
  'perf-playerjoin': 'player-join',
  'perf-remotemotion': 'remote-motion',
};

function scenarioName(run: RunData): string | null {
  return SCENARIO_BY_LABEL[run.meta.label] ?? null;
}

function metricValue(row: PerfPhaseSummary, metric: PerfBudgetMetric): number | null {
  switch (metric) {
    case 'worstFrameDeltaMs':
      return row.worstFrameDeltaMs;
    case 'longTaskTotalMs':
      return row.longTaskTotalMs;
    case 'maxRemoteJumpUnits':
      return row.maxRemoteJumpUnits;
    case 'flickerIndex':
      return row.flickerIndex;
    case 'timeToPlayableMs':
      return null;
  }
}

function checkMetric(name: string, metric: PerfBudgetMetric, actual: number | null | undefined, budget: number): PerfBudgetCheck {
  if (actual === null || actual === undefined || !Number.isFinite(actual)) {
    return { status: 'SKIP', name, metric, budget, reason: 'metric not measured' };
  }
  return actual <= budget
    ? { status: 'PASS', name, metric, actual, budget }
    : { status: 'FAIL', name, metric, actual, budget };
}

export function evaluatePerfBudgets(run: RunData, budgets: PerfBudgetFile): PerfBudgetCheck[] {
  const scenario = scenarioName(run);
  if (!scenario) return [];

  const scenarioBudget = budgets[scenario];
  if (!scenarioBudget) return [{ status: 'SKIP', name: scenario, reason: 'no scenario budget' }];

  const checks: PerfBudgetCheck[] = [];
  if (scenario === 'cold-load' && run.perf?.landmarks) {
    const classBudget = scenarioBudget[run.meta.characterClass];
    if (!classBudget) {
      checks.push({ status: 'SKIP', name: `${scenario}.${run.meta.characterClass}`, reason: 'no budget entry' });
    } else if (classBudget.timeToPlayableMs !== undefined) {
      checks.push(
        checkMetric(
          `${scenario}.${run.meta.characterClass}.timeToPlayableMs`,
          'timeToPlayableMs',
          run.perf.landmarks.timeToPlayableMs,
          classBudget.timeToPlayableMs,
        ),
      );
    }
  }

  for (const row of summarizePerfByPhase(run)) {
    const phaseBudget = scenarioBudget[row.phase];
    if (!phaseBudget) {
      checks.push({ status: 'SKIP', name: `${scenario}.${row.phase}`, reason: 'no budget entry' });
      continue;
    }
    for (const [metric, budget] of Object.entries(phaseBudget) as Array<[PerfBudgetMetric, number]>) {
      checks.push(checkMetric(`${scenario}.${row.phase}.${metric}`, metric, metricValue(row, metric), budget));
    }
  }

  return checks;
}

export function formatPerfBudgetCheck(check: PerfBudgetCheck): string {
  const prefix = `perf-budget ${check.status} ${check.name}`;
  if (check.status === 'SKIP') return `${prefix} (${check.reason ?? 'skipped'})`;
  const actual = check.actual?.toFixed(check.metric === 'flickerIndex' || check.metric === 'maxRemoteJumpUnits' ? 3 : 1);
  return check.status === 'PASS'
    ? `${prefix} ${actual} <= ${check.budget}`
    : `${prefix} ${actual} > ${check.budget}`;
}