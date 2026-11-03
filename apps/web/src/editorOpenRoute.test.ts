import { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vitest";

import { REMOTE_EDITOR_UNAVAILABLE_REASON, resolveEditorOpenRoute } from "./editorOpenRoute";

const primary = EnvironmentId.make("primary");
const remote = EnvironmentId.make("remote");

describe("resolveEditorOpenRoute", () => {
  it("opens paths of the primary environment, or of no known environment, on this machine", () => {
    for (const environmentId of [primary, null, undefined]) {
      expect(
        resolveEditorOpenRoute({ environmentId, primaryEnvironmentId: primary, sshTarget: null }),
      ).toEqual({ kind: "local" });
    }
  });

  it("opens a machine added over SSH through the editor's SSH remote support", () => {
    expect(
      resolveEditorOpenRoute({
        environmentId: remote,
        primaryEnvironmentId: primary,
        sshTarget: { alias: "me@build-box", hostname: "10.0.0.5", username: null, port: 2222 },
      }),
    ).toEqual({ kind: "remote-ssh", host: "build-box", username: "me" });
  });

  it("never sends another machine's path to this machine's editor", () => {
    expect(
      resolveEditorOpenRoute({
        environmentId: remote,
        primaryEnvironmentId: primary,
        sshTarget: null,
      }),
    ).toEqual({ kind: "unavailable", reason: REMOTE_EDITOR_UNAVAILABLE_REASON });
    // Before the primary environment is known, a thread's environment is not assumed to be it.
    expect(
      resolveEditorOpenRoute({ environmentId: remote, primaryEnvironmentId: null, sshTarget: null })
        .kind,
    ).toBe("unavailable");
  });
});
