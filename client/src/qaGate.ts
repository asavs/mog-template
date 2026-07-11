export type QaGateOptions = {
  envQaMode?: string | boolean;
  search?: string;
};

/**
 * Shared QA-runtime gate. The harness can force this with `?qa`; CI/preview
 * builds can force it with VITE_QA_MODE. Keep every QA-only browser feature
 * behind this one predicate so production behavior has one audit point.
 */
export function shouldEnableQaGameDebug({
  envQaMode = import.meta.env.VITE_QA_MODE,
  search = typeof window === 'undefined' ? '' : window.location.search,
}: QaGateOptions = {}) {
  if (typeof envQaMode === 'boolean') return envQaMode;

  const normalizedEnv = envQaMode?.trim().toLowerCase();
  if (
    normalizedEnv === '1' ||
    normalizedEnv === 'true' ||
    normalizedEnv === 'yes' ||
    normalizedEnv === 'on'
  ) {
    return true;
  }

  return new URLSearchParams(search).has('qa');
}