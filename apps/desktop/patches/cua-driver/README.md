# Cua driver patches

Ryco builds the Cua driver (`cua-driver`, upstream 0.40.1) from source with two Ryco-owned patches on
top. They started as Synara's native patches (Synara 1.0.4, PR #1915, native revision 40; MIT, Copyright
T3 Tools Inc. and Emanuele Di Pietro, see `docs/licenses/synara-computer-use.txt`) and were ported by Ryco
onto 0.40.1 for native revision 41. The upstream driver's license is in `docs/licenses/cua-driver.txt`;
both MIT notices stay with any copy of these patches. The port's design note is
`docs/superpowers/specs/2026-11-07-cua-driver-0.40-upgrade.md`.

- `0001-ryco-native.patch`: the native extensions Ryco's Computer Use relies on. Applied on every
  platform.
- `0002-ryco-linux-browser.patch`: the Linux browser input controls. Applied after 0001, on Linux only.

## What 0001 adds to upstream 0.40.1

- **Embedded host:** the host-owned `expected_input_epoch`, the private `cancel_input` /
  `interrupt_input` methods with their cleanup acknowledgement, the drain on host EOF, the host-pid
  watcher, a panic-safe exit, and the `synara_native_revision` metadata. Tools that would post input
  outside admission (`run_steps`, `run_script`, `replay_trajectory`, the raw mouse tools) and
  `set_config` are refused to the embedded host.
- **Input safety (macOS):** one input gate at upstream's central post functions. Every key and button
  down has its release built first, chords release in reverse order, pacing waits can be interrupted,
  and each mouse event is submitted once. Exact-window target checks (ownership, visibility, active
  Space, observed bounds), the modal guard, secure-input refusal and per-window mutation lanes.
- **Truthful results:** action diagnostics (`delivery_path`, `focus_mutation`, `restore_status`), no
  pixel fallback after an attempted accessibility press, and text progress that never trusts partial
  echoes from web or Electron targets (no retry offset there; "Requested (unverified)", "do not
  replay").
- **Tools and arguments upstream lacks:** `check_input_ready`, `list_spaces`, `wait_for_settle`,
  `select_text`, `set_window_minimized`, `set_app_visibility`, the internal `set_agent_cursor_style`;
  `semantic_only` and `force_synthetic` text, `set_value append`, scroll deltas and modifiers,
  `coordinate_space:"window_points"` with `expected_window_bounds`, `include_keyboard_focus`, windowless
  `invoke_menu`, `launch_app hidden`, `screenshot_frame_freshness`.
- **Clipboard preservation (revision 40):** `clipboard_write` with `preserve: true` and a
  `preserve_token`, restore with `restore_token`; bounded snapshots and image decoding.
- **Browser:** the cancellation scope with release pairing that tolerates a click opening a page dialog,
  headless driver-owned launch by default (`windowed: true` opts in), pid-only binding, `dom_event`
  typing, navigation verification and the semantic outline changes.
- **Cursor:** the compact cursor (`--compact-cursor`: input never waits on animation, no session badge,
  a short paint-only glide planned by upstream's motion crate), its style override, and
  `--cursor-ignore-saved-config` plus pinning flags so the user's `~/.cua-driver/config.json` cannot
  restyle the embedded cursor.
- **Fixes to upstream found while porting:** the keyboard layout is read on the main queue (upstream's
  layout-aware keys read it from a worker thread, which macOS 27 traps); `invoke_menu` makes the addressed
  window key without raising it before a background menu press, as upstream's `hotkey` already does.

What upstream now does itself was dropped: SkyLight background delivery, the exact window raise, the
post-action observation bound (`SYNARA_CUA_*_OBSERVATION_MS`; upstream waits at most 300 ms), the
codesign `--strict` change and the unused revision-34 focus restore. Policies where Ryco differs from
upstream: background pixel clicks never make the target key or take the user's key window, and there is
no off-target Chromium primer click. Background popups, menus, dropdowns, menu shortcuts and drags follow
upstream.

## Bumping the native revision

These move together, in one change:

1. both patch files, never edited by hand: commit the pinned source, apply 0001 and commit, make the
   change, and take `git diff` (with context) from the pristine commit as the new 0001; then apply 0002
   on top and take the Linux delta the same way;
2. `version`, `source`, `sha256` (the release's `darwin-universal-binary.tar.gz` checksum, provenance
   only), `nativeRevision`, `patchSha256` and `linuxBrowserPatchSha256` in
   `packages/shared/src/cuaDriverRelease.json`;
3. the `metadata["synara_native_revision"] = serde_json::json!(N)` literal that 0001 writes into
   `crates/cua-driver/src/serve.rs` (0002 carries it as context). The daemon reports this literal, not the
   manifest, and the desktop host retires every daemon whose reported revision differs from the manifest.
   The key keeps its historical name because it is the wire protocol.

`apps/desktop/scripts/cua-driver-release.test.mjs` checks the checksums and the literal against the
manifest.

Ryco builds the patched driver only on macOS (`apps/desktop/scripts/build-computer-beta.mjs`, through
`provision-cua-driver.mjs`); PR CI neither builds nor applies the patches, so a broken patch would first fail
in the release job. Before changing a patch, apply both to the pinned upstream source with
`patch --batch --forward -p1` and with `git apply --check`, then run a local provisioner build
(`node apps/desktop/scripts/provision-cua-driver.mjs --arch arm64`, or `--source-checkout <cua clone>` to
skip the download). Since 0.39 the build also needs `libs/cua/crates/cua-telemetry` and two JSON files from
outside `libs/cua-driver`; the provisioner archives them.
