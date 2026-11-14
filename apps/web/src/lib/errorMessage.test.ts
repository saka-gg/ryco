import { WorkItemProviderError } from "@ryco/contracts";
import { describe, expect, it } from "vitest";

import { errorMessage } from "./errorMessage";

describe("errorMessage", () => {
  it("uses non-empty Error messages first", () => {
    expect(errorMessage(new Error("Readable message"), "fallback")).toBe("Readable message");
  });

  it("uses tagged provider error details when message is empty", () => {
    const error = new WorkItemProviderError({
      provider: "jira",
      operation: "workItems.get",
      detail: "Jira returned invalid JSON for the requested resource.",
    });

    expect(error.message).toBe("");
    expect(errorMessage(error, "fallback")).toBe(
      "Jira returned invalid JSON for the requested resource.",
    );
  });

  it("never yields blank text for an Error with an empty or blank message", () => {
    expect(errorMessage(new Error(""), "fallback")).toBe("fallback");
    expect(errorMessage(new Error("   "), "fallback")).toBe("fallback");
    expect(errorMessage(Object.assign(new Error(""), { detail: "  " }), "fallback")).toBe(
      "fallback",
    );
  });

  it("uses a thrown string, trimmed", () => {
    expect(errorMessage("  Request timed out.  ", "fallback")).toBe("Request timed out.");
  });

  it("falls back for empty or unknown errors", () => {
    expect(errorMessage("", "fallback")).toBe("fallback");
    expect(errorMessage({ detail: "" }, "fallback")).toBe("fallback");
    expect(errorMessage(null, "fallback")).toBe("fallback");
  });
});
