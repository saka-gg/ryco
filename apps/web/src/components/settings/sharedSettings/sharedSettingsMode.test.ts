import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  SHARED_ROW_OPEN_TTL_MS,
  requestSharedRowOpen,
  takeSharedRowOpen,
  useSharedRowOpenRequest,
} from "./sharedSettingsMode";

afterEach(() => {
  useSharedRowOpenRequest.setState({ key: null });
});

describe("a request to open a shared row", () => {
  it("opens its row once, while the row mounts in time", () => {
    requestSharedRowOpen("worktreeRoot", 1_000);
    expect(takeSharedRowOpen("chatsRoot", 1_500)).toBe(false);
    expect(takeSharedRowOpen("worktreeRoot", 1_500)).toBe(true);
    expect(takeSharedRowOpen("worktreeRoot", 1_600)).toBe(false);
  });

  it("is dropped when its row never mounted in time, so it never opens later", () => {
    requestSharedRowOpen("worktreeRoot", 1_000);
    expect(takeSharedRowOpen("worktreeRoot", 1_000 + SHARED_ROW_OPEN_TTL_MS)).toBe(false);
    expect(useSharedRowOpenRequest.getState().key).toBeNull();
  });
});
