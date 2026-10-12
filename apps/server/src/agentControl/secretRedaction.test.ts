import { assert, describe, it } from "@effect/vitest";

import {
  makeSharedPayloadSecretRedactor,
  redactAgentControlSecrets,
  redactAgentControlSecretText,
} from "./secretRedaction.ts";

const bearer = `rycoac_${"a".repeat(43)}`;
const bootstrap = `rycoacb_${"b".repeat(43)}`;

describe("redactAgentControlSecrets", () => {
  it("returns the same reference when there is nothing to redact", () => {
    const value = {
      message: { content: [{ type: "text", text: "hello rycoac without a token" }] },
      list: [1, "two", { three: 3 }],
    };
    assert.strictEqual(redactAgentControlSecrets(value), value);
    assert.strictEqual(redactAgentControlSecretText("plain"), "plain");
  });

  it("copies only the paths that held a secret", () => {
    const untouched = { big: "x".repeat(1_000) };
    const value = {
      untouched,
      headers: [{ name: "authorization", value: `Bearer ${bearer}` }],
      env: { RYCO_BOOTSTRAP: bootstrap },
    };
    const redacted = redactAgentControlSecrets(value) as typeof value;

    assert.notStrictEqual(redacted, value);
    assert.strictEqual(redacted.untouched, untouched);
    assert.strictEqual(redacted.headers[0]?.value, "Bearer [REDACTED]");
    assert.strictEqual(redacted.env.RYCO_BOOTSTRAP, "[REDACTED]");
    // The input is never mutated.
    assert.strictEqual(value.headers[0]?.value, `Bearer ${bearer}`);
  });

  it("flattens errors and redacts their messages", () => {
    assert.deepStrictEqual(redactAgentControlSecrets([new TypeError(`bad ${bearer}`)]), [
      { name: "TypeError", message: "bad [REDACTED]" },
    ]);
  });
});

describe("makeSharedPayloadSecretRedactor", () => {
  it("walks a shared message once and reuses the result for every event", () => {
    const redactor = makeSharedPayloadSecretRedactor();
    const message = { type: "system", text: `token ${bearer}` };
    const first = redactor.event({
      type: "task.progress",
      payload: { summary: "ok" },
      raw: { source: "claude.sdk.message", payload: message },
    });
    const second = redactor.event({
      type: "subagent.updated",
      payload: { detail: `leak ${bootstrap}` },
      raw: { source: "claude.sdk.message", payload: message },
    });

    assert.deepStrictEqual(first.raw.payload, { type: "system", text: "token [REDACTED]" });
    assert.strictEqual(second.raw.payload, first.raw.payload);
    assert.strictEqual(redactor.payload(message), first.raw.payload);
    assert.strictEqual(second.payload.detail, "leak [REDACTED]");
  });

  it("keeps events without secrets by reference", () => {
    const redactor = makeSharedPayloadSecretRedactor();
    const event = {
      type: "task.progress",
      payload: { summary: "ok" },
      raw: { source: "claude.sdk.message", payload: { workflow_progress: [{ index: 0 }] } },
    };
    assert.strictEqual(redactor.event(event), event);
  });
});
