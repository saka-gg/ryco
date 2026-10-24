# Cua driver patches

Ryco builds the Cua driver (`cua-driver`, upstream 0.28.2) from source with two patches on top. Both are
byte-identical copies of Synara's patches at commit `d36a31a29` (PR #1915, Synara 1.0.4), MIT licensed,
Copyright T3 Tools Inc. and Emanuele Di Pietro (see `docs/licenses/synara-computer-use.txt`). The upstream
driver's license is in `docs/licenses/cua-driver.txt`.

- `0001-synara-native.patch`: the native extensions Ryco's Computer Use relies on (input admission and
  cancellation for the authenticated embedded host, exact window targeting and background delivery, bounded
  accessibility reads, and from revision 40 clipboard preservation). Applied on every platform.
- `0002-synara-linux-browser.patch`: the Linux browser input controls. Applied after 0001, on Linux only.

Synara's `apps/desktop/patches/cua-driver/README.md` at that commit documents every native revision in
detail. Do not edit a patch by hand; take a new upstream copy instead.

## Native revision 40

Revision 40 makes text progress truthful: a retry offset needs an exact inserted prefix, and a short
read-back after Return, Enter or Tab is reported as unverifiable instead of guessed. Window-scoped
accessibility reads exclude document and web roots that the matched window does not own, including web
documents parked outside their own window, and recheck retained targets before mutating them
(`native_input_target_changed`). Window enumeration omits the driver's own cursor-overlay window.

`clipboard_write` accepts `preserve: true` with a caller-generated UUID `preserve_token`. The driver
snapshots every clipboard item and representation (up to 16 MiB, 32 items and 128 formats, zeroized after
use) before it writes, and `clipboard_write({ restore_token })` restores the snapshot. `clipboard_restored`
is `false` when a newer external copy was kept instead. An unreadable or oversized clipboard is refused
before anything is replaced. Images are opened through a no-follow regular-file handle with a 16 MiB input,
8192-pixel dimension, 64 MiB allocation and 16-megapixel output limit; a changed canonical path is refused
before the file is read. A 120-second native timer and driver teardown also try to restore an unclaimed
snapshot. macOS has no atomic cross-process pasteboard compare-and-swap: the driver checks `changeCount`
right before its clear and write and never overwrites an observed external copy, but a hard kill of the
driver cannot restore anything.

## Bumping the native revision

These move together, in one change:

1. both patch files, copied byte for byte;
2. `nativeRevision`, `patchSha256` and `linuxBrowserPatchSha256` in `packages/shared/src/cuaDriverRelease.json`;
3. the `metadata["synara_native_revision"] = serde_json::json!(N)` literal that 0001 writes into
   `crates/cua-driver/src/serve.rs` (0002 carries it as context). The daemon reports this literal, not the
   manifest, and the desktop host retires every daemon whose reported revision differs from the manifest.

`apps/desktop/scripts/cua-driver-release.test.mjs` checks the checksums and the literal against the
manifest.

Ryco builds the patched driver only on macOS (`apps/desktop/scripts/build-computer-beta.mjs`, through
`provision-cua-driver.mjs`); PR CI neither builds nor applies the patches, so a broken patch would first fail
in the release job. Before changing a patch, apply both to the pinned upstream source with
`patch --batch --forward -p1` and with `git apply --check`, then run a local provisioner build.
