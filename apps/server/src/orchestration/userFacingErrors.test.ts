import { assert, describe, it } from "@effect/vitest";
import { GitCommandError } from "@ryco/contracts";
import { Cause } from "effect";

import { PersistenceSqlError } from "../persistence/Errors.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  ProviderInstanceNotFoundError,
  ProviderSessionNotFoundError,
} from "../provider/Errors.ts";
import {
  failureTag,
  STORAGE_FAILURE_DETAIL,
  UNEXPECTED_FAILURE_DETAIL,
  USER_FACING_ERROR_MAX_CHARS,
  userFacingFailureDetail,
} from "./userFacingErrors.ts";

const requestError = (detail: string) =>
  new ProviderAdapterRequestError({ provider: "codex", method: "turn/start", detail });

describe("userFacingFailureDetail", () => {
  it("returns a provider request error detail unchanged", () => {
    assert.equal(
      userFacingFailureDetail(Cause.fail(requestError("Provider disconnected"))),
      "Provider disconnected",
    );
  });

  it("maps storage failures to a storage message without internal names", () => {
    const detail = userFacingFailureDetail(
      Cause.fail(
        new PersistenceSqlError({
          operation: "ProviderSessionDirectory.upsert",
          detail: "Failed to execute ProviderSessionDirectory.upsert",
        }),
      ),
    );
    assert.equal(detail, STORAGE_FAILURE_DETAIL);
    assert.notInclude(detail, "SQL");
    assert.notInclude(detail, "PersistenceSqlError");
    assert.notInclude(detail, "ProviderSessionDirectory.upsert");
  });

  it("maps missing sessions and instances to plain text", () => {
    assert.equal(
      userFacingFailureDetail(Cause.fail(new ProviderSessionNotFoundError({ threadId: "t-1" }))),
      "The provider session is no longer running.",
    );
    assert.equal(
      userFacingFailureDetail(
        Cause.fail(new ProviderAdapterSessionNotFoundError({ provider: "codex", threadId: "t-1" })),
      ),
      "The provider session is no longer running.",
    );
    assert.include(
      userFacingFailureDetail(
        Cause.fail(new ProviderInstanceNotFoundError({ instanceId: "codex_work" })),
      ),
      "codex_work",
    );
  });

  it("returns the validation issue", () => {
    assert.equal(
      userFacingFailureDetail(
        Cause.fail(
          new ProviderAdapterValidationError({
            provider: "grok",
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          }),
        ),
      ),
      "Turn requires non-empty text or attachments.",
    );
  });

  it("prefers a typed detail over a verbose message, then Error.message, then strings", () => {
    assert.equal(
      userFacingFailureDetail(
        Cause.fail(
          new GitCommandError({
            operation: "renameBranch",
            command: "git branch -m a b",
            cwd: "/tmp/repo",
            detail: "Branch already exists.",
          }),
        ),
      ),
      "Branch already exists.",
    );
    assert.equal(userFacingFailureDetail(Cause.fail(new Error("boom"))), "boom");
    assert.equal(userFacingFailureDetail(Cause.fail("plain failure")), "plain failure");
  });

  it("falls back for defects and interrupts and respects a custom fallback", () => {
    assert.equal(userFacingFailureDetail(Cause.die(new Error("boom"))), UNEXPECTED_FAILURE_DETAIL);
    assert.equal(
      userFacingFailureDetail(Cause.die(new Error("boom")), { fallback: "Steering failed." }),
      "Steering failed.",
    );
    assert.equal(userFacingFailureDetail(Cause.interrupt()), UNEXPECTED_FAILURE_DETAIL);
    assert.equal(
      userFacingFailureDetail(Cause.interrupt(), { fallback: "Interrupted." }),
      "Interrupted.",
    );
  });

  it("falls back for empty or whitespace-only details", () => {
    assert.equal(userFacingFailureDetail(Cause.fail(requestError(""))), UNEXPECTED_FAILURE_DETAIL);
    assert.equal(
      userFacingFailureDetail(Cause.fail(requestError("   \n\t "))),
      UNEXPECTED_FAILURE_DETAIL,
    );
    assert.equal(
      userFacingFailureDetail(Cause.fail(requestError(" ")), { fallback: "Try again." }),
      "Try again.",
    );
  });

  it("bounds long text without trailing whitespace or split surrogate pairs", () => {
    const long = userFacingFailureDetail(Cause.fail(requestError("x".repeat(1_500))));
    assert.isAtMost(long.length, USER_FACING_ERROR_MAX_CHARS);
    assert.equal(long, long.trimEnd());

    const spaced = userFacingFailureDetail(
      Cause.fail(requestError(`${"y".repeat(USER_FACING_ERROR_MAX_CHARS - 2)}   tail`)),
    );
    assert.equal(spaced, "y".repeat(USER_FACING_ERROR_MAX_CHARS - 2));

    const emoji = "\u{1F600}";
    const surrogate = userFacingFailureDetail(
      Cause.fail(requestError(`${"z".repeat(USER_FACING_ERROR_MAX_CHARS - 1)}${emoji}`)),
    );
    assert.equal(surrogate, "z".repeat(USER_FACING_ERROR_MAX_CHARS - 1));

    assert.equal(
      userFacingFailureDetail(Cause.fail(requestError("abcdefghij")), { maxChars: 4 }),
      "abcd",
    );
  });

  it("never returns stack frames", () => {
    const withStack = new Error("boom");
    const causes: ReadonlyArray<Cause.Cause<unknown>> = [
      Cause.die(withStack),
      Cause.fail(withStack),
      Cause.fail(`failed\n    at handler (file.ts:1:1)\n    at main (file.ts:2:2)`),
      Cause.fail(requestError(`provider died\n    at Object.<anonymous> (x.js:1:1)`)),
      Cause.combine(Cause.fail(requestError("first")), Cause.die(withStack)),
    ];
    for (const cause of causes) {
      const detail = userFacingFailureDetail(cause);
      assert.notInclude(detail, "\n    at ");
      assert.isAbove(detail.length, 0);
    }
  });

  it("strips frame-shaped lines in every common V8 form", () => {
    const frames = [
      "    at handler (file.ts:1:1)",
      "    at file:///srv/ryco/bin.mjs:10:5",
      "    at async Promise.all (index 0)",
      "    at new Promise (<anonymous>)",
      "\tat Module._compile (node:internal/modules/cjs/loader:1256:14)",
    ];
    for (const frame of frames) {
      assert.equal(
        userFacingFailureDetail(Cause.fail(requestError(`provider died\r\n${frame}\r\n`))),
        "provider died",
      );
    }
  });

  it("keeps prose lines that merely start with 'at'", () => {
    for (const detail of [
      "Rate limit reached. Try again\nat 14:05 UTC.",
      "The provider is busy, please retry\n  at a later time",
      "Quota exceeded\n  at noon (UTC)",
    ]) {
      assert.equal(userFacingFailureDetail(Cause.fail(requestError(detail))), detail);
    }
  });
});

describe("failureTag", () => {
  it("classifies typed failures, plain errors, defects and interrupts", () => {
    assert.equal(failureTag(Cause.fail(requestError("x"))), "ProviderAdapterRequestError");
    assert.equal(failureTag(Cause.fail(new TypeError("x"))), "TypeError");
    assert.equal(failureTag(Cause.die(new Error("boom"))), "defect");
    assert.equal(failureTag(Cause.interrupt()), "interrupt");
  });
});
