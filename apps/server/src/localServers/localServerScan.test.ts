import { describe, expect, it } from "vite-plus/test";

import {
  isSharedProcessGroup,
  listenerOrigin,
  parseLsofListeners,
  parseProcEnvironThreadId,
  parseProcessTable,
  parsePsEnvironmentThreadIds,
  type ProcessRow,
  stoppableProcessGroup,
} from "./localServerScan.ts";

const SERVER_PID = 500;

/** A process table from rows `[pid, ppid, pgid, stat?, tty?]`. */
function table(rows: ReadonlyArray<readonly [number, number, number, string?, boolean?]>) {
  return new Map<number, ProcessRow>(
    rows.map(([pid, ppid, pgid, stat = "S", hasTty = false]) => [
      pid,
      { pid, ppid, pgid, stat, hasTty, startTimeMs: 1_000 + pid },
    ]),
  );
}

describe("parseLsofListeners", () => {
  it("keeps loopback and wildcard listeners per process and drops other addresses", () => {
    const output = [
      "p4100",
      "cnode",
      "f21",
      "n127.0.0.1:5173",
      "f22",
      "n[::1]:5173",
      "f23",
      "n192.168.1.20:5173",
      "p4200",
      "cpython3",
      "f3",
      "n*:8000",
      "f4",
      "n127.0.0.2:9000 (LISTEN)",
      "pnot-a-pid",
      "n*:1",
      "",
    ].join("\n");
    expect(parseLsofListeners(output)).toEqual([
      { pid: 4100, processName: "node", host: "127.0.0.1", port: 5173 },
      { pid: 4100, processName: "node", host: "[::1]", port: 5173 },
      { pid: 4200, processName: "python3", host: "*", port: 8000 },
      { pid: 4200, processName: "python3", host: "127.0.0.2", port: 9000 },
    ]);
  });
});

describe("parseProcessTable", () => {
  it("reads pid, parent, group, flags, terminal and start time in the C locale", () => {
    const rows = parseProcessTable(
      [
        "    1     0     1 Ss   ??       Fri Oct 30 05:27:47 2026    ",
        "13138 99322 13138 SNs  ??       Sat Oct 31 02:55:29 2026",
        "87004 80630 87004 Ss+  ttys001  Sat Oct 31 01:00:00 2026",
        "  901   900   900 S    pts/3    Sat Oct 31 01:00:01 2026",
        "garbage line",
      ].join("\n"),
    );
    expect(rows.get(13138)).toEqual({
      pid: 13138,
      ppid: 99322,
      pgid: 13138,
      stat: "SNs",
      hasTty: false,
      startTimeMs: Date.parse("Sat Oct 31 02:55:29 2026"),
    });
    expect(rows.get(87004)?.hasTty).toBe(true);
    expect(rows.get(901)?.hasTty).toBe(true);
    expect(rows.size).toBe(4);
  });
});

describe("thread markers", () => {
  it("reads only RYCO_THREAD_ID from /proc/<pid>/environ", () => {
    const credential = ["sk", "live", "abc123"].join("-");
    expect(
      parseProcEnvironThreadId(
        ["PATH=/usr/bin", `API_KEY=${credential}`, "RYCO_THREAD_ID=thread-1", ""].join("\0"),
      ),
    ).toBe("thread-1");
    expect(parseProcEnvironThreadId(["PATH=/usr/bin", "XRYCO_THREAD_ID=no"].join("\0"))).toBe(null);
    // Two different values: ambiguous, so not attributed.
    expect(
      parseProcEnvironThreadId(["RYCO_THREAD_ID=a", "RYCO_THREAD_ID=b"].join("\0")),
    ).toBeNull();
  });

  it("takes macOS markers only from the environment part of `ps -E`, never from the arguments", () => {
    const withEnvironment = [
      "  4100 node vite.js PATH=/usr/bin RYCO_THREAD_ID=thread-1",
      // Spelled out in its arguments only: `ps -E` shows the same text as plain `ps`.
      "  4200 node fake.js RYCO_THREAD_ID=thread-2 HOME=/Users/a",
      // Arguments that claim one thread, an environment that names another.
      "  4300 node x.js RYCO_THREAD_ID=thread-2 RYCO_THREAD_ID=thread-3",
      "  4400 node gone.js RYCO_THREAD_ID=thread-1",
      "  4500 node no-marker.js PATH=/usr/bin",
    ].join("\n");
    const commandOnly = [
      "  4100 node vite.js",
      "  4200 node fake.js RYCO_THREAD_ID=thread-2",
      "  4300 node x.js RYCO_THREAD_ID=thread-2",
      // 4400 exited between the two reads.
      "  4500 node no-marker.js",
    ].join("\n");
    const markers = parsePsEnvironmentThreadIds(
      withEnvironment,
      commandOnly,
      [4100, 4200, 4300, 4400, 4500, 4600],
    );
    expect(Object.fromEntries(markers)).toEqual({
      4100: "thread-1",
      4200: null,
      4300: "thread-3",
      4400: null,
      4500: null,
      4600: null,
    });
  });

  it("drops a pid whose command line spans two lines, so a newline cannot forge a row", () => {
    const forged = "  4100 sh -c x\n  4100 RYCO_THREAD_ID=thread-9";
    expect(
      parsePsEnvironmentThreadIds(`${forged} RYCO_THREAD_ID=thread-9`, forged, [4100]).get(4100),
    ).toBeNull();
  });
});

describe("stoppableProcessGroup", () => {
  // launchd(1) → desktop shell (400, group 400) → this server (500, group 400)
  //   ├─ agent CLI (510, the server's group) → agent tool shell (520, own group) → dev server (521)
  //   ├─ terminal shell (530, session leader with a terminal) → job (531, own group)
  //   └─ persistent agent shell (540 under 510, session leader with a terminal) → job (541)
  const processes = table([
    [400, 1, 400],
    [500, 400, 400],
    [510, 500, 400],
    [520, 510, 520, "Ss"],
    [521, 520, 520],
    [530, 500, 530, "Ss+", true],
    [531, 530, 531, "S+", true],
    [540, 510, 540, "Ss", true],
    [541, 540, 540, "S", true],
    [600, 1, 600],
  ]);

  it("signals the job's own group: an agent tool shell's or a terminal job's", () => {
    expect(stoppableProcessGroup(processes, 521, SERVER_PID)).toBe(520);
    expect(stoppableProcessGroup(processes, 531, SERVER_PID)).toBe(531);
    // A daemonized server that left every Ryco process behind.
    expect(stoppableProcessGroup(processes, 600, SERVER_PID)).toBe(600);
  });

  it("refuses the server's own group, which holds its ancestor and the agent CLI", () => {
    expect(stoppableProcessGroup(processes, 510, SERVER_PID)).toBeNull();
    expect(stoppableProcessGroup(processes, 400, SERVER_PID)).toBeNull();
    expect(isSharedProcessGroup(processes, 400, SERVER_PID)).toBe(true);
  });

  it("refuses a terminal shell and a persistent agent shell whose jobs share its group", () => {
    expect(stoppableProcessGroup(processes, 530, SERVER_PID)).toBeNull();
    expect(stoppableProcessGroup(processes, 541, SERVER_PID)).toBeNull();
  });

  it("refuses a group that holds a direct child of the server", () => {
    const detachedAgent = table([
      [500, 1, 500],
      [700, 500, 700, "Ss"],
      [701, 700, 700],
    ]);
    expect(stoppableProcessGroup(detachedAgent, 701, SERVER_PID)).toBeNull();
  });

  it("refuses every group when the server's own row is missing from the table", () => {
    const withoutServer = table([
      [400, 1, 400],
      [600, 1, 600],
    ]);
    expect(stoppableProcessGroup(withoutServer, 600, SERVER_PID)).toBeNull();
  });

  it("refuses an unknown pid and the init group", () => {
    expect(stoppableProcessGroup(processes, 999, SERVER_PID)).toBeNull();
    expect(stoppableProcessGroup(table([[2, 0, 1]]), 2, SERVER_PID)).toBeNull();
  });
});

describe("listenerOrigin", () => {
  const processes = table([
    [500, 1, 500],
    [510, 500, 400],
    [520, 510, 520],
    [521, 520, 520],
    [530, 500, 530, "Ss+", true],
    [531, 530, 531, "S+", true],
    [600, 1, 600],
  ]);

  it("tells a terminal's servers from an agent's and from orphans", () => {
    expect(listenerOrigin(processes, 521, SERVER_PID)).toBe("agent");
    expect(listenerOrigin(processes, 531, SERVER_PID)).toBe("terminal");
    expect(listenerOrigin(processes, 600, SERVER_PID)).toBe("unknown");
    expect(listenerOrigin(processes, 999, SERVER_PID)).toBe("unknown");
  });
});
