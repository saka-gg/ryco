/**
 * A desktop backend in miniature for desktopParentLifetime.integration.test.ts:
 * the backend's fd-4 pipe wiring, a launched server layer with the shutdown
 * log at its head and its loggers below, and `NodeRuntime.runMain`, around a
 * finalizer that records that it ran. Node runs this file directly (the repo
 * only uses erasable TypeScript syntax).
 *
 * Usage: desktopParentLifetimeBackend.ts <stateDir> graceful
 *        desktopParentLifetimeBackend.ts <stateDir> hung <shutdownTimeoutMs>
 * - graceful: the production wiring; the finalizer finishes.
 * - hung: the finalizer never finishes, and the watchdog waits the given time
 *   instead of the production 20 s.
 *
 * It writes into <stateDir>: `ready` (its pid, once running), `finalizer-started`,
 * `finalized`, `log` (every log line) and `exit-code`.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import { Socket } from "node:net";
import * as NodePath from "node:path";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";

import {
  DesktopParentLossShutdownLogLive,
  watchDesktopParentPipe,
  withDesktopParentLifetime,
} from "../../src/desktopParentLifetime.ts";
import {
  initializeDesktopResourceTelemetry,
  makeDesktopResourceTelemetry,
} from "../../src/diagnostics/DesktopResourceTelemetry.ts";

const [stateDir = ".", mode = "graceful", shutdownTimeoutMs] = process.argv.slice(2);
const statePath = (name: string) => NodePath.join(stateDir, name);
const record = (name: string, content = "") => NodeFS.writeFileSync(statePath(name), content);

process.on("exit", (code) => record("exit-code", String(code)));

if (mode === "hung") {
  const pipe = new Socket({ fd: 4, readable: true, writable: true });
  pipe.unref();
  makeDesktopResourceTelemetry(pipe);
  watchDesktopParentPipe(pipe, { shutdownTimeoutMs: Number(shutdownTimeoutMs) });
} else {
  initializeDesktopResourceTelemetry(4);
}

const finalizer =
  mode === "hung"
    ? Effect.sync(() => record("finalizer-started")).pipe(Effect.andThen(Effect.never))
    : Effect.sync(() => record("finalizer-started")).pipe(
        // Writes to stdout and stderr, as the server's shutdown logging does.
        // Once the app is killed they are broken pipes, and an unhandled EPIPE
        // would end the backend before its finalizers finish.
        Effect.andThen(Effect.logInfo("finalizer started")),
        Effect.andThen(
          Effect.sync(() => {
            process.stdout.write("finalizer stdout\n");
            process.stderr.write("finalizer stderr\n");
          }),
        ),
        Effect.andThen(Effect.sleep("50 millis")),
        Effect.andThen(Effect.logInfo("finalizer finished")),
        Effect.andThen(Effect.sync(() => record("finalized"))),
      );

// Added to the default logger, which writes to the console.
const fileLogger = Logger.make(({ message }) => {
  NodeFS.appendFileSync(statePath("log"), `${JSON.stringify(message)}\n`);
});

const BackendLive = DesktopParentLossShutdownLogLive.pipe(
  Layer.provideMerge(
    Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.sync(() => record("ready", String(process.pid))),
        () => finalizer,
      ),
    ),
  ),
  Layer.provide(Logger.layer([fileLogger], { mergeWithExisting: true })),
);

NodeRuntime.runMain(withDesktopParentLifetime(Layer.launch(BackendLive)));
