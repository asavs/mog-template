/**
 * Procedural placeholder content.
 *
 * Importing this module registers every generator, which is what binds the
 * content keys to their placeholder implementations. Each generator is a
 * stand-in for art that does not exist yet: dropping a matching file into
 * `../dropin/` overrides it without touching this directory.
 *
 * Generators are registered under the content key itself (see `../manifest.ts`
 * for the resolution order).
 *
 * MOTION used to be generated here too — some fifteen hundred lines of authored
 * keyframes across twenty-one keys. It is gone. The Quaternius libraries cover
 * every key it covered except the sideways and backward gaits, and carrying a
 * second, worse implementation of the other fifteen to keep six alive was a poor
 * trade. Those six now resolve to nothing at all, deliberately and visibly, and
 * the plan is to synthesise them from the forward clips we already have —
 * reversed playback for backpedal, a hip-yaw offset on the lower band for
 * strafes — rather than hand-author them a second time.
 *
 * The registry itself is untouched: `registerMotionGenerator` still exists, so
 * this is an absence of content, not a removal of the mechanism.
 */

import './body';
import './props';

export {};
