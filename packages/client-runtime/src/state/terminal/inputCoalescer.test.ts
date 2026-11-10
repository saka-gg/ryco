import { describe, expect, it } from "vitest";

import { createTerminalInputCoalescer } from "./inputCoalescer.ts";

const deferred = () => {
  let resolve: () => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("terminal input coalescer", () => {
  it("sends the first key at once and merges keys typed while it is unanswered", async () => {
    const sent: string[] = [];
    const answers: Array<ReturnType<typeof deferred>> = [];
    const input = createTerminalInputCoalescer({
      send: (data) => {
        sent.push(data);
        const answer = deferred();
        answers.push(answer);
        return answer.promise;
      },
    });
    input.push("l");
    input.push("s");
    input.push(" ");
    input.push("-la");
    expect(sent).toEqual(["l"]);
    expect(input.pendingLength()).toBe(5);
    answers[0]!.resolve();
    await flush();
    expect(sent).toEqual(["l", "s -la"]);
    answers[1]!.resolve();
    await flush();
    input.push("\r");
    expect(sent).toEqual(["l", "s -la", "\r"]);
  });

  it("reports a failed write and carries on in order", async () => {
    const sent: string[] = [];
    const errors: unknown[] = [];
    let fail = true;
    const input = createTerminalInputCoalescer({
      send: async (data) => {
        sent.push(data);
        if (fail) {
          fail = false;
          throw new Error("offline");
        }
      },
      onError: (error) => errors.push(error),
    });
    input.push("a");
    input.push("b");
    await flush();
    expect(sent).toEqual(["a", "b"]);
    expect(errors).toHaveLength(1);
  });

  it("splits a long input at the write limit without splitting a surrogate pair", async () => {
    const sent: string[] = [];
    const input = createTerminalInputCoalescer({
      send: async (data) => {
        sent.push(data);
      },
      maxWriteCodeUnits: 4,
    });
    input.push("abc😀def");
    for (let i = 0; i < 5; i++) await flush();
    expect(sent).toEqual(["abc", "😀de", "f"]);
    expect(sent.join("")).toBe("abc😀def");
  });
});
