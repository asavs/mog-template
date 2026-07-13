/**
 * Print the beta (or prod) feel-test URL, live deploy SHA, and optional PR alignment.
 *
 *   npm run qa:beta
 *   npm run qa:beta -- --pr 20
 *   npm run qa:beta -- --require-align --pr 20
 *   npm run qa:beta -- --offline
 */
import {
  formatResolvedTarget,
  parseTargetArgs,
  resolveTarget,
} from './resolve-target';

async function main() {
  const args = parseTargetArgs(process.argv.slice(2));
  // Default this CLI to beta — that's what "qa:beta" means.
  const target = args.prod ? 'prod' : 'beta';
  const resolved = await resolveTarget({
    target,
    pr: args.pr,
    expectSha: args.expectSha,
    offline: args.offline,
  });

  console.log(formatResolvedTarget(resolved));

  // Machine-readable one-liner for scripts: last line after a marker.
  console.log(`QA_CLIENT_URL=${resolved.clientUrl}`);

  if (args.requireAlign && resolved.alignment?.match === false) {
    console.error('[qa:beta] alignment required but live deploy does not match expected PR/SHA');
    process.exitCode = 2;
  } else if (args.requireAlign && resolved.alignment?.match == null && (args.pr != null || args.expectSha)) {
    console.error('[qa:beta] alignment required but could not verify (missing deploy.json / gh / network)');
    process.exitCode = 2;
  } else if (resolved.remote && resolved.deploy.source === 'none' && !args.offline) {
    console.error('[qa:beta] WARNING: could not reach live deploy metadata — is the host up?');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[qa:beta] failed:', err);
  process.exit(1);
});
