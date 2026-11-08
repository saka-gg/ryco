import { describe, expect, it, vi } from "vite-plus/test";

import { taskSearchGroup } from "./taskSearchSource";

describe("taskSearchGroup", () => {
  it("turns the Tasks feature's answer into Search's Tasks group, opening each task", () => {
    const route = { name: "TaskDetail", params: { environmentId: "env-a", taskId: "t1" } };
    const open = vi.fn();
    const group = taskSearchGroup(
      {
        results: [
          {
            key: "env-a:t1",
            title: "Fix the queue",
            subtitle: "MacBook · ryco",
            done: false,
            trailing: "Tue",
            route,
          },
          {
            key: "env-a:t2",
            title: "Ship it",
            subtitle: "MacBook · done",
            done: true,
            trailing: null,
            route,
          },
        ],
        loading: false,
      },
      open,
    );
    expect(group).toMatchObject({ scope: "tasks", loading: false });
    expect(group.results[0]).toMatchObject({
      key: "task:env-a:t1",
      icon: "checklist",
      detail: "MacBook · ryco",
      trailing: "Tue",
    });
    expect(group.results[1]).toMatchObject({ icon: "checkmark.circle" });
    expect(group.results[1]).not.toHaveProperty("trailing");
    group.results[0]?.open();
    expect(open).toHaveBeenCalledWith(route);
  });
});
