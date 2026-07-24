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
 */

import './body';
import './props';
import './motion';

export {};
