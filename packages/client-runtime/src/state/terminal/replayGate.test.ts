import { describe, expect, it } from "vite-plus/test";
import { createTerminalReplayGate } from "./replayGate.ts";

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
