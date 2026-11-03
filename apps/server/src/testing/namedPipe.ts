import { execFileSync } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";

/** Creates a FIFO at `fifoPath`. POSIX only. */
export const makeNamedPipe = (fifoPath: string): void => {
  execFileSync("mkfifo", [fifoPath]);
};

/** Opens and closes the pipe's other end, which completes any open still waiting on it. */
export const releaseNamedPipe = (fifoPath: string): void => {
  closeSync(openSync(fifoPath, constants.O_RDWR | constants.O_NONBLOCK));
};

/**
 * Opening a FIFO without O_NONBLOCK waits for its other end and cannot be
 * cancelled. This races `operation` against a deadline and then releases the
 * pipe, so a regression fails the test instead of stranding a libuv worker.
 */
export async function settleBeforeNamedPipeDeadline<T>(
  fifoPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Waited on the named pipe at ${fifoPath}.`)),
          2_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    releaseNamedPipe(fifoPath);
  }
}
