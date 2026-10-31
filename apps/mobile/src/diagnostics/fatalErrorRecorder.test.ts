import { describe, expect, it } from "vite-plus/test";

import {
  appendFatalErrorRecord,
  type ErrorUtilsLike,
  FATAL_ERROR_RECORD_LIMIT,
  type FatalErrorStore,
  installFatalErrorRecorder,
  parseFatalErrorRecords,
} from "./fatalErrorRecorder";

const NOW = Date.parse("2026-10-31T06:00:00.000Z");

function memoryStore(initial: string | null = null): FatalErrorStore & { text: string | null } {
  const store = {
    text: initial,
    read: () => store.text,
    write: (text: string) => {
      store.text = text;
    },
    clear: () => {
      store.text = null;
    },
  };
  return store;
}

function fakeErrorUtils() {
  const calls: Array<{ error: unknown; isFatal: boolean | undefined }> = [];
  let handler: (error: unknown, isFatal?: boolean) => void = (error, isFatal) =>
    calls.push({ error, isFatal });
  const errorUtils: ErrorUtilsLike = {
    getGlobalHandler: () => handler,
    setGlobalHandler: (next) => {
      handler = next;
    },
  };
  return {
    errorUtils,
    calls,
    fire: (error: unknown, isFatal?: boolean) => handler(error, isFatal),
  };
}

describe("fatal error recorder", () => {
  it("writes a fatal error before the previous handler runs, and ignores the rest", () => {
    const store = memoryStore();
    const seenByPrevious: Array<{ isFatal: boolean | undefined; stored: string | null }> = [];
    let handler: (error: unknown, isFatal?: boolean) => void = (_error, isFatal) =>
      seenByPrevious.push({ isFatal, stored: store.text });
    installFatalErrorRecorder({
      errorUtils: {
        getGlobalHandler: () => handler,
        setGlobalHandler: (next) => {
          handler = next;
        },
      },
      store: () => store,
      now: () => NOW,
    });

    handler(new TypeError("undefined is not a function"), false);
    expect(store.text).toBeNull();
    handler(new TypeError("cannot read property 'id' of undefined"), true);
    expect(seenByPrevious.map((call) => call.isFatal)).toEqual([false, true]);
    // The record was on disk when the previous handler (red box, app exit) ran.
    expect(seenByPrevious[1]?.stored).not.toBeNull();
    expect(parseFatalErrorRecords(store.text, NOW)).toEqual([
      expect.objectContaining({
        at: "2026-10-31T06:00:00.000Z",
        message: "TypeError: cannot read property 'id' of undefined",
      }),
    ]);
  });

  it("keeps the last ten records of the last seven days, bounded in size", () => {
    let text: string | null = JSON.stringify([
      { at: "2026-10-20T00:00:00.000Z", message: "too old", stack: null },
    ]);
    for (let index = 0; index < 12; index += 1) {
      text = appendFatalErrorRecord(text, new Error(`crash ${index}${"x".repeat(2000)}`), NOW);
    }
    const records = parseFatalErrorRecords(text, NOW);
    expect(records).toHaveLength(FATAL_ERROR_RECORD_LIMIT);
    expect(records[0]?.message.startsWith("Error: crash 2")).toBe(true);
    expect(records.every((record) => record.message.length <= 1024)).toBe(true);
    expect(records.some((record) => record.message === "too old")).toBe(false);
    expect(parseFatalErrorRecords("{not json", NOW)).toEqual([]);
  });

  it("never lets a failing file change how the app fails", () => {
    const { errorUtils, calls, fire } = fakeErrorUtils();
    installFatalErrorRecorder({
      errorUtils,
      store: () => ({
        read: () => {
          throw new Error("disk gone");
        },
        write: () => undefined,
        clear: () => undefined,
      }),
    });
    expect(() => fire(new Error("boom"), true)).not.toThrow();
    expect(calls).toHaveLength(1);
  });
});
