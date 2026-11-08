import { describe, expect, it } from "vite-plus/test";

import { describeProjectRemoval } from "./removal.ts";

describe("describeProjectRemoval", () => {
  it("names the threads it deletes and that it cannot be undone", () => {
    expect(
      describeProjectRemoval({
        name: "app",
        cwd: "/srv/app",
        environmentLabel: "Mac mini",
        threadCount: 2,
      }),
    ).toEqual({
      title: 'Remove project "app" and delete its 2 threads?',
      lines: [
        "Path: /srv/app",
        "Environment: Mac mini",
        "This permanently clears conversation history for those threads.",
        "This removes only this project entry.",
        "This action cannot be undone.",
      ],
    });
  });

  it("keeps an empty project's removal short", () => {
    expect(
      describeProjectRemoval({
        name: "app",
        cwd: "/srv/app",
        environmentLabel: null,
        threadCount: 0,
      }),
    ).toEqual({
      title: 'Remove project "app"?',
      lines: ["Path: /srv/app", "This removes only this project entry."],
    });
  });
});
