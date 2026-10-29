import { describe, expect, it } from "vite-plus/test";

import { safeTerminalError } from "./terminalErrors";

describe("safe terminal errors", () => {
  it("maps tagged errors without exposing their path or defect text", () => {
    const raw = "/private/secret/workspace";
    const result = safeTerminalError({
      _tag: "TerminalCwdError",
      cwd: raw,
      cause: new Error(`ENOENT ${raw}`),
    });
    expect(result.title).toBe("Workspace unavailable");
    expect(JSON.stringify(result)).not.toContain(raw);
    expect(JSON.stringify(result)).not.toContain("ENOENT");
  });

  it("maps unknown failures to stable retry copy", () => {
    const result = safeTerminalError(new Error("opaque server detail"));
    expect(result).toEqual({
      title: "Terminal unavailable",
      detail: "Reload the terminal view and try again.",
    });
  });
});
