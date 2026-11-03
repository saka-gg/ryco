import { describe, expect, it } from "vite-plus/test";

import { createTerminalSpawnEnv } from "./terminalSpawnEnv.ts";

describe("createTerminalSpawnEnv", () => {
  it("drops Ryco's and the dev server's variables and the ports that point at Ryco", () => {
    expect(
      createTerminalSpawnEnv({
        PATH: "/usr/bin",
        HOME: "/home/a",
        RYCO_PORT: "3773",
        ryco_home: "/x",
        VITE_DEV_SERVER_URL: "http://localhost:5173",
        PORT: "3773",
        ELECTRON_RUN_AS_NODE: "1",
        ELECTRON_RENDERER_PORT: "5173",
        UNSET: undefined,
      }),
    ).toEqual({ PATH: "/usr/bin", HOME: "/home/a" });
  });

  it("keeps the caller's own variables as they are", () => {
    expect(
      createTerminalSpawnEnv(
        { PATH: "/usr/bin", TERM: "dumb" },
        {
          TERM: "xterm-256color",
          RYCO_PROJECT_ROOT: "/repo",
        },
      ),
    ).toEqual({ PATH: "/usr/bin", TERM: "xterm-256color", RYCO_PROJECT_ROOT: "/repo" });
  });

  it("marks a thread terminal with its thread, over an inherited or requested marker", () => {
    expect(
      createTerminalSpawnEnv(
        // A Ryco started from another Ryco's thread inherits that thread's marker.
        { PATH: "/usr/bin", RYCO_THREAD_ID: "outer-thread" },
        { RYCO_THREAD_ID: "requested-thread" },
        "thread-1",
      ),
    ).toEqual({ PATH: "/usr/bin", RYCO_THREAD_ID: "thread-1" });
  });

  it("leaves a terminal without a thread (a provider sign-in) unmarked", () => {
    expect(
      createTerminalSpawnEnv({ PATH: "/usr/bin", RYCO_THREAD_ID: "outer-thread" }, null),
    ).toEqual({ PATH: "/usr/bin" });
  });
});
