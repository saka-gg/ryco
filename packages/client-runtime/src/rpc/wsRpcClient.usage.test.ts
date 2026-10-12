import { USAGE_CONTRACT_VERSION, WS_METHODS } from "@ryco/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./wsTransport.ts", () => ({
  WsTransport: class WsTransport {
    request = vi.fn();
  },
}));

import { isUsageContractMismatch, USAGE_UPDATE_MESSAGE } from "../usage/compatibility.ts";
import { createWsRpcClient } from "./wsRpcClient.ts";
import { type WsTransport } from "./wsTransport.ts";

const request = {
  contractVersion: USAGE_CONTRACT_VERSION,
  endDate: "2026-08-10",
  timeZone: "UTC",
} as const;

function harness(summary: () => Effect.Effect<unknown, unknown>) {
  const getConfig = vi.fn(() => Effect.succeed({ usageContractVersion: USAGE_CONTRACT_VERSION }));
  const getUsageSummary = vi.fn(() => Effect.suspend(summary));
  const requestOptions: unknown[] = [];
  const transport = {
    request: (invoke: (client: unknown) => Effect.Effect<unknown, unknown>, options?: unknown) => {
      requestOptions.push(options);
      return Effect.runPromise(
        invoke({
          [WS_METHODS.serverGetConfig]: getConfig,
          [WS_METHODS.serverGetUsageSummary]: getUsageSummary,
        }) as Effect.Effect<unknown>,
      );
    },
  };
  const client = createWsRpcClient(transport as unknown as WsTransport);
  return { client, getConfig, getUsageSummary, requestOptions };
}

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

describe("wsRpcClient usage summary", () => {
  it("sends the summary request alone, without a server config round trip", async () => {
    const { client, getConfig, getUsageSummary } = harness(() =>
      Effect.succeed({ contractVersion: USAGE_CONTRACT_VERSION }),
    );
    await client.server.getUsageSummary(request);
    await client.server.getUsageSummary(request);
    expect(getConfig).not.toHaveBeenCalled();
    expect(getUsageSummary).toHaveBeenCalledTimes(2);
  });

  it("passes the caller's abort signal to the transport", async () => {
    const { client, requestOptions } = harness(() =>
      Effect.succeed({ contractVersion: USAGE_CONTRACT_VERSION }),
    );
    const controller = new AbortController();
    await client.server.getUsageSummary(request, { signal: controller.signal });
    await client.server.getUsageSummary(request);
    expect(requestOptions).toEqual([{ signal: controller.signal }, undefined]);
  });

  it("never sends a request built for another contract", async () => {
    const { client, getUsageSummary } = harness(() =>
      Effect.succeed({ contractVersion: USAGE_CONTRACT_VERSION }),
    );
    const error = await rejection(
      client.server.getUsageSummary({ ...request, contractVersion: USAGE_CONTRACT_VERSION + 1 }),
    );
    expect(isUsageContractMismatch(error)).toBe(true);
    expect(getUsageSummary).not.toHaveBeenCalled();
  });

  it.each([
    [
      "an older summary this client cannot decode",
      new Error('Expected 2\n  at ["contractVersion"]'),
    ],
    [
      "a node whose schema rejects this request (a bare RPC defect)",
      'Expected 1, got 2\n  at ["contractVersion"]',
    ],
    ["a node that predates the method", `Unknown request tag: ${WS_METHODS.serverGetUsageSummary}`],
    ["a node that refuses the contract", new Error(USAGE_UPDATE_MESSAGE)],
  ])("reports %s as a contract mismatch", async (_label, failure) => {
    const { client } = harness(() => Effect.fail(failure));
    const error = await rejection(client.server.getUsageSummary(request));
    expect(isUsageContractMismatch(error)).toBe(true);
  });

  it("keeps other failures as they are, and asks again next time", async () => {
    let fail = true;
    const { client, getUsageSummary } = harness(() =>
      fail
        ? Effect.fail(new Error("scan failed"))
        : Effect.succeed({ contractVersion: USAGE_CONTRACT_VERSION }),
    );
    const error = await rejection(client.server.getUsageSummary(request));
    expect(isUsageContractMismatch(error)).toBe(false);
    expect((error as Error).message).toBe("scan failed");
    fail = false;
    await expect(client.server.getUsageSummary(request)).resolves.toEqual({
      contractVersion: USAGE_CONTRACT_VERSION,
    });
    expect(getUsageSummary).toHaveBeenCalledTimes(2);
  });
});
