/**
 * The one place where the pinned Unica version lives.
 *
 * Everything that acquires or labels a runtime reads this module:
 *   - scripts/setup-backend.mjs  (local `runtime/` for the current host)
 *   - scripts/package.mjs        (dist/ archives for linux-x64 and win-x64)
 *   - scripts/generate-manifest.mjs (version recorded in the runtime manifest)
 *
 * `package.json` carries the same version for the pi package itself; the two
 * are checked against each other by scripts/lib/toolchain.mjs so a half-done
 * version bump fails loudly instead of shipping a mislabelled archive.
 */

/** Upstream release tag of the Unica core (`unica-runtime-<target>.tar.gz`). */
export const UNICA_VERSION = "v0.13.0";

/** The same version without the tag prefix, as reported by the release metadata. */
export const UNICA_CORE_VERSION = "0.13.0";

/** Repository that publishes the core runtime archives and their metadata. */
export const UNICA_RELEASE_REPO = "https://github.com/IngvarConsulting/unica";
