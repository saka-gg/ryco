import { describe, expect, it } from "vite-plus/test";

import { ServerListeningDetector } from "./serverListeningDetector.ts";

describe("ServerListeningDetector", () => {
  it("resolves when the server logs the listening line", async () => {
    const detector = new ServerListeningDetector();

    detector.push("[01:23:30.571] INFO (#148): Listening on http://0.0.0.0:7011\n");

    await expect(detector.promise).resolves.toBeUndefined();
  });

  it("resolves when the listening line arrives across multiple chunks", async () => {
    const detector = new ServerListeningDetector();

    detector.push("[01:23:30.571] INFO (#148): Listen");
    detector.push("ing on http://0.0.0.0:7011\n");

    await expect(detector.promise).resolves.toBeUndefined();
  });

  it("rejects when the server exits before logging readiness", async () => {
    const detector = new ServerListeningDetector();
    const error = new Error("server exited");

    detector.fail(error);

    await expect(detector.promise).rejects.toBe(error);
  });

  it("waits for the full port before checking it against the assigned one", async () => {
    const detector = new ServerListeningDetector({ expectedPort: 7926 });
    let settled = false;
    void detector.promise.then(
      () => (settled = true),
      () => (settled = true),
    );

    detector.push("INFO (#1): Listening on http://127.0.0.1:79");
    await Promise.resolve();
    expect(settled).toBe(false);
    detector.push("26\n");

    await expect(detector.promise).resolves.toBeUndefined();
  });

  it("rejects a backend listening on a port the desktop did not assign", async () => {
    const detector = new ServerListeningDetector({ expectedPort: 7926 });
    detector.push("INFO (#1): Listening on http://[::]:3773\n");
    await expect(detector.promise).rejects.toThrow("listening on port 3773, expected 7926");
  });
});
