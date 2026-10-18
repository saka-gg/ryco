import { describe, expect, it } from "vite-plus/test";

import { aggregateLocalTaskStatus, LOCAL_TASK_STATUS_ORDER } from "./localTasks.ts";

describe("aggregateLocalTaskStatus", () => {
  it("is todo without chats", () => {
    expect(aggregateLocalTaskStatus([])).toBe("todo");
  });

  it("ignores chats that are gone", () => {
    expect(aggregateLocalTaskStatus(["unavailable", "unavailable"])).toBe("todo");
    expect(aggregateLocalTaskStatus(["unavailable", "review"])).toBe("review");
  });

  it("takes the most urgent status", () => {
    expect(aggregateLocalTaskStatus(["review", "failed", "running", "starting", "needs-you"])).toBe(
      "needs-you",
    );
    expect(aggregateLocalTaskStatus(["review", "running", "starting"])).toBe("starting");
    expect(aggregateLocalTaskStatus(["review", "failed", "running"])).toBe("running");
    expect(aggregateLocalTaskStatus(["review", "failed"])).toBe("failed");
    expect(aggregateLocalTaskStatus(["review"])).toBe("review");
  });

  it("reads any iterable once, in the documented order", () => {
    function* statuses() {
      yield "review" as const;
      yield "needs-you" as const;
    }
    expect(aggregateLocalTaskStatus(statuses())).toBe("needs-you");
    expect(LOCAL_TASK_STATUS_ORDER).toEqual([
      "needs-you",
      "starting",
      "running",
      "failed",
      "review",
    ]);
  });
});
