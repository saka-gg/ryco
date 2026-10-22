# Resource monitor

The isolated Rust process collects CPU, resident/virtual memory, process identity, and OS I/O counters. It retains bounded in-memory history. The server starts it on first diagnostics use, validates its versioned protocol, and treats unavailable collection as a diagnostics warning rather than a server failure. Command arguments are deliberately excluded.

Adapted from `pingdotgg/t3code` commit `de28fa1ff3ac3c3a96bebd9ec5ce23dd09f61af0`; see [LICENSE](LICENSE). The upstream application and install scripts are not dependencies.

## Build

Install the pinned toolchain without changing your default Rust version:

```sh
rustup toolchain install 1.95.0 --profile minimal
```

From the repository root, `bun run build` and `bun run build:desktop` build the monitor with the locked Cargo dependencies. To build it alone:

```sh
bun scripts/build-resource-monitor.ts
```

The helper also accepts an architecture (`arm64` or `x64`) and platform (`darwin`, `linux`, `win32`). The desktop app packages only the `arm64` macOS monitor; `x64 darwin` builds the npm CLI's Intel Mac monitor. Cross builds require the corresponding Rust target and linker; they never silently substitute a host binary. Linux targets use GNU libc. Runtime collection fails gracefully when the binary is incompatible or unavailable.

Each target binary is stored in the shared, checksum-verified native artifact cache (`~/.ryco/cache/native-builds`, or `RYCO_NATIVE_BUILD_CACHE_DIR`) that the desktop helpers use. Source, toolchain, target, and build-setting changes select a new cache entry; delete the cache to force a rebuild.

Desktop packaging unpacks the executable outside Electron's ASAR archive. Release jobs collect architecture-specific binaries into the CLI package, so the runtime selects a local platform binary without downloading executable code. Native source changes invalidate build caches.

## Checks

```sh
cd native/resource-monitor
cargo test --locked
```

TypeScript tests cover protocol limits, timeouts, startup cancellation, retry, power-sensitive sampling, PID reuse, and safe signaling. The OS may restrict process counters; unavailable metrics must remain distinguishable from measured data.
