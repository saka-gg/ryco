import { constants as osConstants } from "node:os";

import { Effect, Layer } from "effect";
import { PtyAdapter, PtySpawnError } from "../Services/PTY.ts";
import type { PtyAdapterShape, PtyExitEvent, PtyInputMode, PtyProcess } from "../Services/PTY.ts";

/** Bun names the signal ("SIGTERM"); the PTY contract carries its number. */
function signalNumber(name: NodeJS.Signals | null | undefined): number | null {
  return name ? (osConstants.signals[name] ?? null) : null;
}

class BunPtyProcess implements PtyProcess {
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();
  private readonly decoder = new TextDecoder();
  private readonly process: Bun.Subprocess;
  private didExit = false;

  constructor(process: Bun.Subprocess) {
    this.process = process;
    void this.process.exited
      .then((exitCode) => {
        this.emitExit({
          exitCode: Number.isInteger(exitCode) ? exitCode : 0,
          signal: signalNumber(this.process.signalCode),
        });
      })
      .catch(() => {
        this.emitExit({ exitCode: 1, signal: null });
      });
  }

  get pid(): number {
    return this.process.pid;
  }

  write(data: string): void {
    if (!this.process.terminal) {
      throw new Error("Bun PTY terminal handle is unavailable");
    }
    this.process.terminal.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.process.terminal?.resize) {
      throw new Error("Bun PTY resize is unavailable");
    }
    this.process.terminal.resize(cols, rows);
  }

  /** Bun reads termios on the master, which shares the slave's line discipline. */
  async readInputMode(): Promise<PtyInputMode | undefined> {
    try {
      const terminal = this.process.terminal;
      if (!terminal || terminal.closed) return undefined;
      const localFlags = terminal.localFlags;
      const { inputModeFromLocalFlags } = await import("../ttyInputMode.ts");
      return inputModeFromLocalFlags(localFlags, process.platform);
    } catch {
      return undefined;
    }
  }

  kill(signal?: string): void {
    if (!signal) {
      this.process.kill();
      return;
    }
    this.process.kill(signal as NodeJS.Signals);
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => {
      this.dataListeners.delete(callback);
    };
  }

  onExit(callback: (event: PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }

  emitData(data: Uint8Array): void {
    if (this.didExit) return;
    const text = this.decoder.decode(data, { stream: true });
    if (text.length === 0) return;
    for (const listener of this.dataListeners) {
      listener(text);
    }
  }

  private emitExit(event: PtyExitEvent): void {
    if (this.didExit) return;
    this.didExit = true;

    const remainder = this.decoder.decode();
    if (remainder.length > 0) {
      for (const listener of this.dataListeners) {
        listener(remainder);
      }
    }

    for (const listener of this.exitListeners) {
      listener(event);
    }
  }
}

export const layer = Layer.effect(
  PtyAdapter,
  Effect.gen(function* () {
    if (process.platform === "win32") {
      return yield* Effect.die(
        "Bun PTY terminal support is unavailable on Windows. Please use Node.js (e.g. by running `npx ryco`) instead.",
      );
    }
    return {
      spawn: (input) =>
        Effect.try({
          try: () => {
            let processHandle: BunPtyProcess | null = null;
            const command = [input.shell, ...(input.args ?? [])];
            const subprocess = Bun.spawn(command, {
              cwd: input.cwd,
              env: input.env,
              terminal: {
                cols: input.cols,
                rows: input.rows,
                data: (_terminal, data) => {
                  processHandle?.emitData(data);
                },
              },
            });
            processHandle = new BunPtyProcess(subprocess);
            return processHandle;
          },
          catch: (cause) =>
            new PtySpawnError({
              adapter: "bun-pty",
              message: cause instanceof Error ? cause.message : "Failed to spawn PTY process",
              cause,
            }),
        }),
    } satisfies PtyAdapterShape;
  }),
);
