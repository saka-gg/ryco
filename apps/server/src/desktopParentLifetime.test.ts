import { Duplex } from "node:stream";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  DesktopParentLossShutdownLogLive,
  resetDesktopParentLifetimeForTests,
  watchDesktopParentPipe,
  withDesktopParentLifetime,
} from "./desktopParentLifetime.ts";

const desktopPipe = () =>
  new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

/** Ends a little later, so a race against an already lost app would lose it. */
const shortProgram = Effect.sleep("20 millis").pipe(Effect.as("done"));

/** Builds and shuts down the shutdown log layer; returns what it logged. */
const shutdownLog = async () => {
  const messages: unknown[] = [];
  const logger = Logger.make(({ message }) => {
    messages.push(message);
  });
  await Effect.runPromise(
    Effect.scoped(Layer.build(DesktopParentLossShutdownLogLive)).pipe(
      Effect.provide(Logger.layer([logger])),
    ),
  );
  return messages.flat();
};

afterEach(() => resetDesktopParentLifetimeForTests());

describe("desktop parent lifetime", () => {
  it("runs the program unchanged while no desktop pipe is watched", async () => {
    await expect(Effect.runPromise(withDesktopParentLifetime(shortProgram))).resolves.toBe("done");
  });

  it("interrupts the program, finalizers included, once the app closes its end", async () => {
    const pipe = desktopPipe();
    watchDesktopParentPipe(pipe, { closedByBackend: () => false });
    pipe.resume();
    let finalized = false;
    const running = Effect.runPromiseExit(
      withDesktopParentLifetime(
        Effect.never.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              finalized = true;
            }),
          ),
        ),
      ),
    );
    pipe.push(null);
    const exit = await running;
    expect(Exit.hasInterrupts(exit)).toBe(true);
    expect(finalized).toBe(true);
  });

  it("names the app's loss in the shutdown log only when it caused the shutdown", async () => {
    const pipe = desktopPipe();
    watchDesktopParentPipe(pipe, { closedByBackend: () => false });
    pipe.resume();
    expect(await shutdownLog()).toEqual([]);
    const ended = new Promise((resolve) => pipe.once("end", resolve));
    pipe.push(null);
    await ended;
    expect(await shutdownLog()).toEqual(["desktop app is gone; shutting the backend down"]);
  });

  it("ignores a close the backend made itself", async () => {
    const pipe = desktopPipe();
    watchDesktopParentPipe(pipe, { closedByBackend: () => true });
    const closed = new Promise((resolve) => pipe.once("close", resolve));
    pipe.destroy();
    await closed;
    await expect(Effect.runPromise(withDesktopParentLifetime(shortProgram))).resolves.toBe("done");
  });
});
