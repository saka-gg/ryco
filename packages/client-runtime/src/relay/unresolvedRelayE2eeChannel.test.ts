import { describe, expect, it, vi } from "vite-plus/test";

import {
  relayE2eeUnresolvedAttemptFailure,
  type RelayE2eeHost,
  unresolvedRelayE2eeChannel,
} from "./relayEngine.ts";

describe("unresolvedRelayE2eeChannel", () => {
  it("closes with the retryable failure and refuses every frame", async () => {
    const close = vi.fn();
    const host = { close } as unknown as RelayE2eeHost;

    const channel = unresolvedRelayE2eeChannel(host);

    expect(close).toHaveBeenCalledExactlyOnceWith(relayE2eeUnresolvedAttemptFailure());
    expect(relayE2eeUnresolvedAttemptFailure().retryable).toBe(true);
    await expect(channel.intercept(new Uint8Array([1]))).resolves.toEqual({ kind: "rejected" });
    expect(channel.submit(new Uint8Array([1]))).toBe(false);
    await expect(channel.beginClose()).resolves.toBe("refused");
    expect(() => channel.dispose()).not.toThrow();
  });
});
