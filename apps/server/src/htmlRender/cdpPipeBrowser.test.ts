import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Schema } from "effect";

import { launchCdpPipeBrowser } from "./cdpPipeBrowser.ts";

const posix = process.platform !== "win32";

// A stand-in browser on the same pipe (commands on fd 3, replies and events on
// fd 4): it answers `Test.echo`, emits the event a `Test.*` command names, and
// never answers anything else, as Chrome never answers a session whose target
// is gone.
const STAND_IN = `
const fs = require("node:fs");
const out = fs.createWriteStream(null, { fd: 4 });
const send = (message) => out.write(JSON.stringify(message) + "\\0");
let buffer = "";
fs.createReadStream(null, { fd: 3, encoding: "utf8" }).on("data", (chunk) => {
  buffer += chunk;
  for (let end = buffer.indexOf("\\0"); end !== -1; end = buffer.indexOf("\\0")) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (message.method === "Test.echo") send({ id: message.id, result: { ok: true } });
    if (message.method === "Test.detach") {
      send({ method: "Target.detachedFromTarget", params: { sessionId: message.params.sessionId } });
    }
    if (message.method === "Test.crash") {
      send({ method: "Inspector.targetCrashed", params: {}, sessionId: message.params.sessionId });
    }
  }
});
`;

describe("the CDP pipe browser", () => {
  it.live.skipIf(!posix)(
    "fails a session's waiting commands once it detaches or its page crashes",
    () =>
      Effect.gen(function* () {
        const browser = yield* launchCdpPipeBrowser({
          executable: process.execPath,
          args: ["-e", STAND_IN],
          limits: { maxReplyChars: 1024 * 1024, maxEventChars: 1024 * 1024 },
          failure: (failure) => new Error(failure.reason),
          onEvent: () => Effect.void,
        });
        expect(yield* browser.send("Test.echo", {}, Schema.Struct({ ok: Schema.Boolean }))).toEqual(
          {
            ok: true,
          },
        );
        const detached = yield* Effect.forkChild(
          browser.send("Page.getLayoutMetrics", {}, Schema.Unknown, "S1"),
        );
        const crashed = yield* Effect.forkChild(
          browser.send("Page.captureScreenshot", {}, Schema.Unknown, "S2"),
        );
        yield* browser.post("Test.detach", { sessionId: "S1" });
        const first = yield* Fiber.await(detached).pipe(Effect.timeout("5 seconds"));
        expect(Exit.isFailure(first)).toBe(true);
        // Another session's command keeps waiting.
        expect(crashed.pollUnsafe()).toBeUndefined();
        yield* browser.post("Test.crash", { sessionId: "S2" });
        const second = yield* Fiber.await(crashed).pipe(Effect.timeout("5 seconds"));
        expect(Exit.isFailure(second)).toBe(true);
        // A waiter that gives up leaves the pipe usable.
        const timedOut = yield* browser
          .send("Page.navigate", {}, Schema.Unknown, "S3")
          .pipe(Effect.timeout("50 millis"), Effect.exit);
        expect(Exit.isFailure(timedOut)).toBe(true);
        expect(yield* browser.send("Test.echo", {}, Schema.Struct({ ok: Schema.Boolean }))).toEqual(
          {
            ok: true,
          },
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
