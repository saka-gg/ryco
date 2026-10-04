import { describe, expect, it } from "vite-plus/test";
import * as EffectAcpErrors from "effect-acp/errors";
import { ProviderDriverKind } from "@ryco/contracts";
import { Cause, Effect, Exit, Fiber } from "effect";

import { ProviderAdapterRequestError, ProviderAdapterValidationError } from "../Errors.ts";
import {
  acpPermissionOutcome,
  failStartedTurnOnError,
  mapAcpToAdapterError,
  startedTurnFailureMessage,
} from "./AcpAdapterSupport.ts";

describe("AcpAdapterSupport", () => {
  it("preserves transport timeout details for the provider UI", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("acpRegistry"),
      "thread-1" as never,
      "session/start",
      new EffectAcpErrors.AcpTransportError({
        detail: "ACP startup timed out",
        cause: new Error("timeout"),
      }),
    );
    expect(error.message).toContain("ACP startup timed out");
  });
  it("maps ACP approval decisions to permission outcomes", () => {
    expect(acpPermissionOutcome("accept")).toBe("allow-once");
    expect(acpPermissionOutcome("acceptForSession")).toBe("allow-always");
    expect(acpPermissionOutcome("decline")).toBe("reject-once");
  });

  it("maps ACP request errors to provider adapter request errors", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("cursor"),
      "thread-1" as never,
      "session/prompt",
      new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: "Invalid params",
      }),
    );

    expect(error._tag).toBe("ProviderAdapterRequestError");
    expect(error.message).toContain("Invalid params");
  });
});

describe("failStartedTurnOnError", () => {
  const makeRecorder = (terminalEmitted = false) => {
    const emitted: string[] = [];
    const guard = failStartedTurnOnError({
      isTerminalEmitted: () => terminalEmitted,
      emitFailed: (errorMessage) => Effect.sync(() => void emitted.push(errorMessage)),
    });
    return { emitted, guard };
  };
  const requestError = new ProviderAdapterRequestError({
    provider: "cursor",
    method: "session/prompt",
    detail: "prompt failed",
  });

  it("emits exactly once on a typed failure and re-raises the original error", async () => {
    const { emitted, guard } = makeRecorder();
    const exit = await Effect.runPromiseExit(Effect.fail(requestError).pipe(guard));
    expect(emitted).toEqual(["prompt failed"]);
    expect(exit).toEqual(Exit.fail(requestError));
  });

  it("emits on a defect and re-raises it", async () => {
    const { emitted, guard } = makeRecorder();
    const exit = await Effect.runPromiseExit(Effect.die(new Error("boom")).pipe(guard));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain("boom");
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
  });

  it("never emits on success", async () => {
    const { emitted, guard } = makeRecorder();
    expect(await Effect.runPromise(Effect.succeed(42).pipe(guard))).toBe(42);
    expect(emitted).toEqual([]);
  });

  it("never emits on an interrupt-only cause", async () => {
    const { emitted, guard } = makeRecorder();
    const fiber = Effect.runFork(Effect.never.pipe(guard));
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(emitted).toEqual([]);
  });

  it("never emits once the terminal was already emitted", async () => {
    const { emitted, guard } = makeRecorder(true);
    const exit = await Effect.runPromiseExit(Effect.fail(requestError).pipe(guard));
    expect(emitted).toEqual([]);
    expect(exit).toEqual(Exit.fail(requestError));
  });

  it("ignores emission failures and keeps the original failure", async () => {
    const guard = failStartedTurnOnError({
      isTerminalEmitted: () => false,
      emitFailed: () => Effect.die(new Error("pubsub closed")),
    });
    const exit = await Effect.runPromiseExit(Effect.fail(requestError).pipe(guard));
    expect(exit).toEqual(Exit.fail(requestError));
  });
});

describe("startedTurnFailureMessage", () => {
  it("prefers the adapter error detail or issue", () => {
    expect(startedTurnFailureMessage(Cause.fail({ detail: "  detail text  " }))).toBe(
      "detail text",
    );
    expect(
      startedTurnFailureMessage(
        Cause.fail(
          new ProviderAdapterValidationError({
            provider: "cursor",
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          }),
        ),
      ),
    ).toBe("Turn requires non-empty text or attachments.");
  });

  it("never returns an empty message", () => {
    expect(startedTurnFailureMessage(Cause.fail({ detail: "   " })).length).toBeGreaterThan(0);
    expect(startedTurnFailureMessage(Cause.fail("   ")).length).toBeGreaterThan(0);
  });
});
