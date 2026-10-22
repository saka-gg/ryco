import { EnvironmentId } from "@ryco/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  decodeWorkspaceFileDragPayload,
  endWorkspaceFileDrag,
  readWorkspaceFileDragSource,
  readWorkspaceFileDrop,
  resolveWorkspaceFileDrop,
  startWorkspaceFileDrag,
  WORKSPACE_FILE_DRAG_TYPE,
  workspaceFileDropLabel,
} from "./workspaceFileDrag";

const environmentId = EnvironmentId.make("env-1");
const payload = { environmentId, workspaceRoot: "/repo", path: "src/app.ts" };

function fakeTransfer() {
  const data = new Map<string, string>();
  return {
    effectAllowed: "uninitialized" as DataTransfer["effectAllowed"],
    get types() {
      return [...data.keys()];
    },
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
  };
}

afterEach(() => endWorkspaceFileDrag());

describe("workspace file drags", () => {
  it("carries the file as its own type and as plain text", () => {
    const transfer = fakeTransfer();
    startWorkspaceFileDrag(transfer as unknown as DataTransfer, payload);
    expect(transfer.types).toEqual([WORKSPACE_FILE_DRAG_TYPE, "text/plain"]);
    expect(transfer.getData("text/plain")).toBe("src/app.ts");
    expect(transfer.effectAllowed).toBe("copy");
    expect(readWorkspaceFileDragSource()).toEqual(payload);
    expect(readWorkspaceFileDrop(transfer)).toEqual(payload);
    endWorkspaceFileDrag();
    expect(readWorkspaceFileDragSource()).toBeNull();
  });

  it("ignores other drags and malformed payloads", () => {
    const other = fakeTransfer();
    other.setData("text/plain", "src/app.ts");
    expect(readWorkspaceFileDrop(other)).toBeNull();
    const broken = fakeTransfer();
    broken.setData(WORKSPACE_FILE_DRAG_TYPE, "{not json");
    expect(readWorkspaceFileDrop(broken)).toBeNull();
    for (const value of [
      null,
      { ...payload, path: "../escape" },
      { ...payload, environmentId: "" },
      { ...payload, workspaceRoot: 3 },
    ]) {
      expect(decodeWorkspaceFileDragPayload(value)).toBeNull();
    }
    expect(decodeWorkspaceFileDragPayload({ ...payload, path: "./src//app.ts" })).toEqual(payload);
  });

  it("mentions a file only in the composer of its own workspace", () => {
    const base = { environmentId, workspaceRoot: "/repo", disabled: false };
    expect(resolveWorkspaceFileDrop({ ...base, source: payload })).toEqual({ kind: "mention" });
    expect(resolveWorkspaceFileDrop({ ...base, source: null })).toEqual({ kind: "mention" });
    const refusals = [
      resolveWorkspaceFileDrop({ ...base, source: { ...payload, workspaceRoot: "/other" } }),
      resolveWorkspaceFileDrop({
        ...base,
        source: { ...payload, environmentId: EnvironmentId.make("env-2") },
      }),
      resolveWorkspaceFileDrop({ ...base, source: payload, disabled: true }),
      resolveWorkspaceFileDrop({ ...base, source: payload, workspaceRoot: null }),
    ];
    expect(refusals.map((verdict) => verdict.kind === "refused" && verdict.reason)).toEqual([
      "workspace",
      "environment",
      "unavailable",
      "unavailable",
    ]);
    expect(refusals.map(workspaceFileDropLabel)).toEqual([
      "This file is in another workspace",
      "Only files from the same machine can be mentioned",
      "The composer can’t take a mention right now",
      "The composer can’t take a mention right now",
    ]);
  });
});
