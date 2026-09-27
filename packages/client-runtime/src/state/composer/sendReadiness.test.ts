import { afterEach, expect, it } from "vitest";
import { EnvironmentId } from "@ryco/contracts";
import type { EnvironmentConnection } from "../../connection/connection.ts";
import {
  recordWsConnectionAttempt,
  recordWsConnectionOpened,
  recordWsConnectionClosed,
  resetWsConnectionStateForTests,
} from "../../rpc/wsConnectionState.ts";
import { captureReviewedSendReadiness } from "./sendReadiness.ts";
afterEach(resetWsConnectionStateForTests);
it("a reconnect and new live shell cannot revive an old reviewed send", () => {
  const environmentId = EnvironmentId.make("fixture-env");
  const metadata = { environmentId };
  let generation: object | null = {};
  const connection = {
    shellSnapshotReadiness: { read: () => generation },
  } as EnvironmentConnection;
  recordWsConnectionAttempt("ws://fixture.invalid", metadata);
  recordWsConnectionOpened(metadata);
  const guard = captureReviewedSendReadiness(environmentId, () => connection);
  expect(guard).not.toThrow();
  recordWsConnectionClosed({ code: 1006, reason: "fixture disconnect", wasClean: false }, metadata);
  generation = null;
  expect(guard).toThrow("connection changed");
  recordWsConnectionAttempt("ws://fixture.invalid", metadata);
  recordWsConnectionOpened(metadata);
  generation = {};
  expect(guard).toThrow("connection changed");
  expect(captureReviewedSendReadiness(environmentId, () => connection)).not.toThrow();
});
