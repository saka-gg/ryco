import { describe, expect, it } from "vite-plus/test";
import { createTerminalReplayGate, isTerminalReplyData } from "./replayGate.ts";

/** Parses writes in order when told to, like an emulator's asynchronous write buffer. */
function createQueuedWriter(onParse: (data: string) => void) {
  const queue: Array<{ data: string; callback: (() => void) | undefined }> = [];
  return {
    write(data: string, callback?: () => void) {
      queue.push({ data, callback });
    },
    parse() {
      for (let next = queue.shift(); next; next = queue.shift()) {
        onParse(next.data);
        next.callback?.();
      }
    },
  };
}

describe("isTerminalReplyData", () => {
  it("recognizes the reports xterm sends for queries", () => {
    for (const reply of [
      "\u001b[?1;2c",
      "\u001b[>0;276;0c",
      "\u001b[0n",
      "\u001b[12;1R",
      "\u001b[?12;1R",
      "\u001b[?2026;2$y",
      "\u001b[4;2$y",
      "\u001b[8;24;80t",
      "\u001b[?31u",
      "\u001b]11;rgb:0000/0000/0000\u001b\\",
      "\u001b]10;rgb:ffff/ffff/ffff\u0007",
      "\u001bP1$r0m\u001b\\",
      "\u001bP0$r\u001b\\",
      "\u001bP>|xterm.js(6.0.0)\u001b\\",
      "\u009b?1;2c",
      "\u00901+r544e=1b\u009c",
    ]) {
      expect(isTerminalReplyData(reply), JSON.stringify(reply)).toBe(true);
    }
  });

  it("leaves typed, pasted and pointer input alone", () => {
    for (const input of [
      "l",
      "ls -la\r",
      "\u0003",
      "\u001b",
      "\u001b[A",
      "\u001b[1;5D",
      "\u001bOR",
      "\u001b[15~",
      "\u001b[I",
      "\u001b[O",
      "\u001b[<0;10;5M",
      "\u001b[200~echo \u001b[6n\u001b[201~",
      "\u001b[12;1Rls",
      "\u001b]11;?",
    ]) {
      expect(isTerminalReplyData(input), JSON.stringify(input)).toBe(false);
    }
  });
});

describe("createTerminalReplayGate", () => {
  it("drops replies to replayed queries until the replay has been parsed", () => {
    const sent: string[] = [];
    let gate!: ReturnType<typeof createTerminalReplayGate>;
    // Answers a cursor position query on parse, then routes the answer like `onData`.
    const writer = createQueuedWriter((data) => {
      if (!data.includes("\u001b[6n")) return;
      if (!gate.dropsData("\u001b[1;1R")) sent.push("\u001b[1;1R");
    });
    gate = createTerminalReplayGate(writer);

    writer.write("live \u001b[6n");
    gate.replay(() => {
      writer.write("history \u001b[6n");
    });
    writer.write("live again \u001b[6n");
    // Written but not yet parsed: a flag around write() would already be down here.
    expect(gate.dropsData("\u001b[1;1R")).toBe(false);
    writer.parse();

    // The live query before the replay and the one after it are answered; the replayed one is not.
    expect(sent).toEqual(["\u001b[1;1R", "\u001b[1;1R"]);
    expect(gate.dropsData("\u001b[1;1R")).toBe(false);
  });

  it("keeps user input flowing while a replay parses", () => {
    let gate!: ReturnType<typeof createTerminalReplayGate>;
    const decisions: boolean[] = [];
    const writer = createQueuedWriter((data) => {
      if (data.length === 0) return;
      decisions.push(gate.dropsData("ls\r"), gate.dropsData("\u001b[?2026;2$y"));
    });
    gate = createTerminalReplayGate(writer);

    gate.replay(() => {
      writer.write("\u001b[?2026$p");
    });
    writer.parse();

    expect(decisions).toEqual([false, true]);
    expect(gate.dropsData("\u001b[?2026;2$y")).toBe(false);
  });

  it("nests replays and lowers the gate even when a replay write throws", () => {
    const writer = createQueuedWriter(() => undefined);
    const gate = createTerminalReplayGate(writer);

    gate.replay(() => {
      gate.replay(() => writer.write("inner"));
    });
    expect(() =>
      gate.replay(() => {
        throw new Error("write buffer full");
      }),
    ).toThrow("write buffer full");
    writer.parse();

    expect(gate.dropsData("\u001b[?1;2c")).toBe(false);
  });
});
