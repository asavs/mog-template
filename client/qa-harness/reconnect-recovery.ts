/**
 * Live proof for issue #121: a mid-session websocket drop recovers on its own,
 * with no page reload.
 *
 * The bug this guards is not expressible in a unit test. `connectionManager.test.ts`
 * proves the policy (schedule, token reuse, user-initiated vs unexpected close);
 * this proves the thing a player actually cares about — that after the socket dies,
 * the world comes back and the character can still be driven — against a real
 * browser, a real SpacetimeDB, and a real severed TCP connection.
 *
 * The kill is `NetProxyLane.dropActiveConnections()` rather than the pre-existing
 * `dropAfterMs`: that knob arms a per-connection timer at accept time, so it would
 * kill the reconnect on the same schedule as the original and a recovery could
 * never be observed. See net-proxy.ts.
 *
 *   npx vite-node qa-harness/reconnect-recovery.ts
 *
 * Env: QA_CLIENT_URL (default http://localhost:5199 — deliberately not 5173, so a
 * dev server from another worktree cannot silently serve the wrong bundle),
 * QA_HEADLESS=1 to hide the window. Writes `reconnect-recovery.webm` at the repo
 * root on success.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startNetProxyLane } from './net-proxy';
import { joinAs, openBotSession, acquirePointerLock, readPlayerState } from './page-driver';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RUNS_DIR = path.join(__dirname, 'runs', 'reconnect-recovery');
const VIDEO_OUT = path.join(REPO_ROOT, 'reconnect-recovery.webm');

const CLIENT_URL = process.env.QA_CLIENT_URL ?? 'http://localhost:5199';
const STDB_HOST = process.env.QA_STDB_HOST ?? '127.0.0.1';
const STDB_PORT = Number(process.env.QA_STDB_PORT ?? 3000);
const HEADLESS = process.env.QA_HEADLESS === '1';

const JOIN_TIMEOUT_MS = 60_000;
const RECOVERY_TIMEOUT_MS = 30_000;
/** Long enough that the movement is unambiguous on video and well past prediction noise. */
const WALK_MS = 1200;
/**
 * How long the listener stays down in phase 2. Must outlast the first few
 * backoff steps (0.5 + 1 + 2 = 3.5s) so the attempt counter demonstrably climbs
 * past one, without dragging the run out to the 10s ceiling.
 */
const OUTAGE_MS = 5_000;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function distance(a: { x: number; z: number }, b: { x: number; z: number }) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

const log = (message: string) => console.log(`[reconnect-recovery] ${message}`);

/**
 * Everything needed to tell the recovery failure modes apart: a session that is
 * back but not rejoined, one that rejoined but lost pointer lock (so input is
 * silently discarded), and one where the join dialog reappeared and stole focus.
 * Cheap enough to log unconditionally at the decisive moment.
 */
async function uiDiagnostics(page: import('playwright').Page) {
  return page.evaluate(() => {
    const game = (window as unknown as {
      __mogGame?: {
        identityHex: string | null;
        store: Record<string, Map<string, unknown>>;
      };
    }).__mogGame;
    const identityHex = game?.identityHex ?? null;
    const store = game?.store as unknown as {
      playerInputAck: Map<string, { lastProcessedClientTick: bigint; lastInputSeq: number }>;
      playerTransform: Map<string, { position: { x: number; y: number; z: number }; serverTick: bigint }>;
    } | undefined;
    const ack = identityHex ? store?.playerInputAck.get(identityHex) : undefined;
    const transform = identityHex ? store?.playerTransform.get(identityHex) : undefined;
    return {
      identityHex,
      ackClientTick: ack ? String(ack.lastProcessedClientTick) : null,
      ackInputSeq: ack ? String(ack.lastInputSeq) : null,
      serverPos: transform ? `${transform.position.x.toFixed(2)},${transform.position.z.toFixed(2)}` : null,
      serverTick: transform ? String(transform.serverTick) : null,
      clientPos: (() => {
        const p = (window as unknown as { __mogGame?: { localPosition?: { x: number; z: number } } }).__mogGame?.localPosition;
        return p ? `${p.x.toFixed(2)},${p.z.toFixed(2)}` : null;
      })(),
      pointerLocked: document.pointerLockElement !== null,
      pointerLockIsBody: document.pointerLockElement === document.body,
      activeElement: document.activeElement?.tagName ?? null,
      joinDialogPresent: !!document.querySelector('.join-overlay'),
      lockHintPresent: !!document.querySelector('.lock-hint'),
      bannerPresent: !!document.querySelector('[data-qa-reconnect]'),
      hudPresent: !!document.querySelector('.hud'),
      playerRows: game?.store.player.size ?? -1,
      transformRows: game?.store.playerTransform.size ?? -1,
      hasOwnPlayerRow: !!(identityHex && game?.store.player.has(identityHex)),
    };
  });
}

async function main() {
  fs.rmSync(RUNS_DIR, { recursive: true, force: true });
  fs.mkdirSync(RUNS_DIR, { recursive: true });

  // No shaping: this run is about the drop, not about latency.
  // Reassigned in phase 2 when the lane is torn down and brought back on the same port.
  let lane = await startNetProxyLane({
    targetHost: STDB_HOST,
    targetPort: STDB_PORT,
    profile: { delayMs: 0, jitterMs: 0 },
  });
  const laneUrl = `ws://127.0.0.1:${lane.port}`;
  log(`proxy lane ${laneUrl} -> ${STDB_HOST}:${STDB_PORT}`);

  const browser = await chromium.launch({ headless: HEADLESS });
  const cfg = {
    clientUrl: CLIENT_URL,
    stdbUrl: laneUrl,
    joinTimeoutMs: JOIN_TIMEOUT_MS,
    runsDir: RUNS_DIR,
    runLabel: 'reconnect-recovery',
  };
  const session = await openBotSession(browser, 'A', cfg);
  const { page } = session;

  try {
    await joinAs(session, cfg);
    log('joined');

    // Survives everything except a document reload — which is exactly the failure
    // mode issue #121 says is currently the ONLY way back, so it is the thing this
    // test must prove did not happen.
    await page.evaluate(() => {
      (window as unknown as { __noReloadSentinel?: string }).__noReloadSentinel = 'original-document';
    });

    const identityBefore = await page.evaluate(
      () => (window as unknown as { __mogGame?: { identityHex: string | null } }).__mogGame?.identityHex ?? null,
    );
    assert(identityBefore, 'expected an identity before the drop');
    log(`identity before drop: ${identityBefore}`);

    await acquirePointerLock(page);

    const spawnPos = (await readPlayerState(page)).sim;
    assert(spawnPos, 'expected a local position before the drop');
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(WALK_MS);
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(400);

    const movedPos = (await readPlayerState(page)).sim;
    assert(movedPos, 'expected a local position after walking');
    const preDropDistance = distance(spawnPos, movedPos);
    log(`moved ${preDropDistance.toFixed(2)}m before the drop`);
    assert(preDropDistance > 0.5, `expected real movement before the drop, got ${preDropDistance.toFixed(3)}m`);

    // --- the drop ---------------------------------------------------------
    const killed = lane.dropActiveConnections();
    log(`severed ${killed} live socket(s) at the proxy`);
    assert(killed > 0, 'proxy had no live sockets to sever — the client was not connected through it');

    const banner = page.locator('[data-qa-reconnect]');
    await banner.waitFor({ state: 'visible', timeout: 15_000 });
    const bannerText = (await banner.innerText()).replace(/\s+/g, ' ').trim();
    log(`banner shown: "${bannerText}"`);
    assert(/attempt \d+/.test(bannerText), `expected an attempt count in the banner, got "${bannerText}"`);

    // --- the recovery -----------------------------------------------------
    await banner.waitFor({ state: 'hidden', timeout: RECOVERY_TIMEOUT_MS });
    log('banner cleared — socket is back');

    // Back on the socket is not the same as back in the world: the server's
    // `cleanup_player` archived the player row on disconnect, so this waits for
    // the automatic `join_game` to have restored it.
    await page.waitForFunction(
      () => {
        const game = (window as unknown as {
          __mogGame?: { identityHex: string | null; store: { player: Map<string, unknown> } };
        }).__mogGame;
        return !!game?.identityHex && game.store.player.has(game.identityHex);
      },
      undefined,
      { timeout: RECOVERY_TIMEOUT_MS },
    );
    log('player row restored server-side');

    const sentinel = await page.evaluate(
      () => (window as unknown as { __noReloadSentinel?: string }).__noReloadSentinel ?? null,
    );
    assert(
      sentinel === 'original-document',
      'the page reloaded — recovery must happen in the live document, which is the entire point of #121',
    );
    log('no reload: original document still live');

    const identityAfter = await page.evaluate(
      () => (window as unknown as { __mogGame?: { identityHex: string | null } }).__mogGame?.identityHex ?? null,
    );
    assert(
      identityAfter === identityBefore,
      `identity changed across the reconnect (${identityBefore} -> ${identityAfter}) — the saved token was not reused`,
    );
    log(`identity preserved: ${identityAfter}`);

    // --- can the player still play? ---------------------------------------
    log(`ui after recovery: ${JSON.stringify(await uiDiagnostics(page))}`);
    await acquirePointerLock(page);
    const beforeSecondWalk = (await readPlayerState(page)).sim;
    assert(beforeSecondWalk, 'expected a local position after recovery');

    // Backward, NOT forward again. The first leg walks toward a wall, and the
    // server clamps to `ARENA_BOUNDS` inset by the player radius (min_z -20 +
    // 0.45 = the -19.55 that `collision.rs`'s own test asserts). Pressing W a
    // second time from there is a legitimate zero-metre move, and reads as
    // "reconnect broke movement" when nothing is broken at all. Retracing the
    // leg we just walked is the only direction guaranteed to have room.
    await page.keyboard.down('KeyS');
    await page.waitForTimeout(WALK_MS);
    await page.keyboard.up('KeyS');
    await page.waitForTimeout(600);
    log(`ui after walk:     ${JSON.stringify(await uiDiagnostics(page))}`);

    const afterSecondWalk = (await readPlayerState(page)).sim;
    assert(afterSecondWalk, 'expected a local position after the post-recovery walk');
    const postDropDistance = distance(beforeSecondWalk, afterSecondWalk);
    log(`moved ${postDropDistance.toFixed(2)}m after the recovery`);
    assert(
      postDropDistance > 0.5,
      `player could not move after recovery (moved ${postDropDistance.toFixed(3)}m) — the session is alive but useless`,
    );

    // The server has to agree, not just the client's prediction: a transform row
    // that tracks the post-recovery walk proves inputs are landing again.
    const serverZ = await page.evaluate(() => {
      const game = (window as unknown as {
        __mogGame?: { identityHex: string | null; store: { playerTransform: Map<string, { position: { x: number; z: number } }> } };
      }).__mogGame;
      if (!game?.identityHex) return null;
      return game.store.playerTransform.get(game.identityHex)?.position ?? null;
    });
    assert(serverZ, 'expected a server transform row after recovery');
    const serverDrift = distance(serverZ, afterSecondWalk);
    log(`server transform (${serverZ.x.toFixed(2)}, ${serverZ.z.toFixed(2)}) vs client ${afterSecondWalk.x.toFixed(2)}, ${afterSecondWalk.z.toFixed(2)} — drift ${serverDrift.toFixed(2)}m`);
    assert(serverDrift < 2.0, `client and server disagree by ${serverDrift.toFixed(2)}m after recovery — prediction did not reset cleanly`);

    // --- phase 2: a real outage, not a blip ------------------------------
    // Severing the socket only ever proves retry #1. Taking the listener down
    // makes the retries actually fail, which is the case the backoff exists for
    // (a server restart, an nginx reload, a carrier NAT drop) and the only way
    // to see the attempt counter climb and the loop refuse to give up.
    log('phase 2: taking the whole lane down');
    await lane.close();

    const bannerAgain = page.locator('[data-qa-reconnect]');
    await bannerAgain.waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForTimeout(OUTAGE_MS);

    const outageText = (await bannerAgain.innerText()).replace(/\s+/g, ' ').trim();
    const attemptMatch = /attempt (\d+)/.exec(outageText);
    log(`banner during outage: "${outageText}"`);
    assert(attemptMatch, `expected an attempt count during the outage, got "${outageText}"`);
    const attempts = Number(attemptMatch[1]);
    assert(
      attempts >= 2,
      `expected the retry loop to have made several attempts during a ${OUTAGE_MS}ms outage, saw ${attempts}`,
    );

    // Same port, so the client's configured URL still resolves — this is the
    // server coming back, not the client being pointed somewhere new.
    log(`bringing the lane back up on port ${lane.port}`);
    lane = await startNetProxyLane({
      targetHost: STDB_HOST,
      targetPort: STDB_PORT,
      listenPort: lane.port,
      profile: { delayMs: 0, jitterMs: 0 },
    });

    await bannerAgain.waitFor({ state: 'hidden', timeout: RECOVERY_TIMEOUT_MS });
    await page.waitForFunction(
      () => {
        const game = (window as unknown as {
          __mogGame?: { identityHex: string | null; store: { player: Map<string, unknown> } };
        }).__mogGame;
        return !!game?.identityHex && game.store.player.has(game.identityHex);
      },
      undefined,
      { timeout: RECOVERY_TIMEOUT_MS },
    );
    log('recovered from the full outage too');

    await acquirePointerLock(page);
    const beforeThirdWalk = (await readPlayerState(page)).sim;
    assert(beforeThirdWalk, 'expected a local position after the outage');
    await page.keyboard.down('KeyS');
    await page.waitForTimeout(WALK_MS);
    await page.keyboard.up('KeyS');
    await page.waitForTimeout(600);
    const afterThirdWalk = (await readPlayerState(page)).sim;
    assert(afterThirdWalk, 'expected a local position after the post-outage walk');
    const outageWalk = distance(beforeThirdWalk, afterThirdWalk);
    log(`moved ${outageWalk.toFixed(2)}m after the outage`);
    assert(outageWalk > 0.5, `player could not move after the outage (moved ${outageWalk.toFixed(3)}m)`);

    log('PASS');
  } catch (error) {
    const shotPath = path.join(RUNS_DIR, 'failure.png');
    await page.screenshot({ path: shotPath }).catch(() => {});
    console.error(`[reconnect-recovery] console tail:\n${session.consoleTail.slice(-40).join('\n')}`);
    throw error;
  } finally {
    // Deliberately not `closeSession`: that helper deletes the recording unless
    // it is handed a RunData to attach it to, and the recording is this test's
    // whole deliverable. Playwright only finalises the file on context close, so
    // the copy has to happen after it and before the browser goes away.
    const video = page.video();
    await page.close().catch(() => {});
    await session.context.close();

    if (video) {
      try {
        fs.copyFileSync(await video.path(), VIDEO_OUT);
        log(`video: ${VIDEO_OUT}`);
      } catch (err) {
        console.warn(`[reconnect-recovery] could not save video: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await browser.close();
    await lane.close();
  }
}

main().catch((error) => {
  console.error('[reconnect-recovery] FAILED:', error);
  process.exit(1);
});
