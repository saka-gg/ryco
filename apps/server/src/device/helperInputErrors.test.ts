import { describe, expect, it } from "vitest";

import { inputRetryFor, isInputNotDeliveredError } from "./helperInputErrors.ts";

/** The helper's non-delivery error, around the bridge's `undeliveredReason`. */
const undelivered = (reason: string): Error =>
  new Error(
    `1 HID event(s) were not delivered to the simulator: ${reason}; inspect the screen before another input`,
  );

describe("reading the helper's input-delivery errors", () => {
  it("recognizes a non-delivery report, old wording included", () => {
    expect(isInputNotDeliveredError(undelivered("nothing was sent: input was not delivered"))).toBe(
      true,
    );
    expect(
      isInputNotDeliveredError(
        new Error("1 HID event(s) were not delivered to the simulator; re-attach and retry"),
      ),
    ).toBe(true);
    expect(isInputNotDeliveredError("simulator is not booted")).toBe(false);
    expect(isInputNotDeliveredError(new Error("display has no framebuffer surface"))).toBe(false);
  });

  it.each([
    {
      name: "an unrelated failure",
      error: new Error("simulator is not booted"),
      transport: "dtuhid",
      retry: "none",
    },
    {
      name: "a refusal for the input deadline",
      error: undelivered("nothing was sent: gesture cannot finish inside the input deadline"),
      transport: "dtuhid",
      retry: "none",
    },
    {
      name: "a partial delivery, even if its detail mentions nothing being sent",
      error: undelivered(
        "input may have been partially delivered; do not replay: the simulator's input service (dtuhidd) is still starting; delivery unknown",
      ),
      transport: "dtuhid",
      retry: "none",
    },
    {
      name: "the old wording, which never says nothing was sent",
      error: new Error("1 HID event(s) were not delivered to the simulator; re-attach and retry"),
      transport: "indigo",
      retry: "none",
    },
    {
      name: "dtuhidd still starting",
      error: undelivered(
        "nothing was sent: the simulator's input service (dtuhidd) is still starting; nothing was sent",
      ),
      transport: "dtuhid",
      retry: "same-attachment",
    },
    {
      name: "a warm-up that left too little time, which is not a deadline refusal",
      error: undelivered(
        "nothing was sent: the simulator's input service (dtuhidd) was still starting and too little time is left for this gesture",
      ),
      transport: "dtuhid",
      retry: "same-attachment",
    },
    {
      name: "any other dtuhidd failure",
      error: undelivered("nothing was sent: dtuhidd did not answer its liveness probe"),
      transport: "dtuhid",
      retry: "same-attachment",
    },
    {
      name: "a stale Indigo client",
      error: undelivered("nothing was sent: input was not delivered"),
      transport: "indigo",
      retry: "reattach",
    },
    {
      name: "an attachment from a helper that does not report its transport",
      error: undelivered("nothing was sent: input was not delivered"),
      transport: null,
      retry: "reattach",
    },
  ] as const)("$name: $retry", ({ error, transport, retry }) => {
    expect(inputRetryFor(error, transport)).toBe(retry);
  });
});
