import { describe, expect, it, vi } from "vitest";
import { ProviderInstanceId, type CodexResetCreditOutcome } from "@ryco/contracts";
import {
  createResetCreditController,
  resetCreditDetailLines,
  type ResetCreditApi,
} from "./resetCredits.ts";

const instanceId = ProviderInstanceId.make("codex-fixture");
const account = {
  accountBinding: "fixture-account-a",
  accountLabel: "fixture@example.test",
  credits: { availableCount: 2 },
};
function fixture() {
  const api: ResetCreditApi = {
    readCodexResetCredits: vi.fn(async () => account),
    consumeCodexResetCredit: vi.fn(async () => ({ outcome: "reset" as const })),
    refreshProviders: vi.fn(async () => ({})),
  };
  const mint = vi.fn(() => "fixture-idempotency-key");
  const controller = createResetCreditController(instanceId, mint);
  return { api, controller, mint };
}
const yes = () => true;

describe("confirmed reset credits", () => {
  it.each<CodexResetCreditOutcome>(["reset", "alreadyRedeemed", "noCredit", "nothingToReset"])(
    "handles %s and refetches",
    async (outcome) => {
      const { api, controller } = fixture();
      vi.mocked(api.consumeCodexResetCredit).mockResolvedValue({ outcome });
      await controller.load(api, yes);
      await controller.confirm(api, yes);
      expect(api.consumeCodexResetCredit).not.toHaveBeenCalled();
      controller.requestConfirmation(true);
      expect(api.consumeCodexResetCredit).not.toHaveBeenCalled();
      await controller.confirm(api, yes);
      expect(controller.getSnapshot().phase).toBe("settled");
      expect(controller.getSnapshot().attempt).toBeUndefined();
      expect(api.consumeCodexResetCredit).toHaveBeenCalledExactlyOnceWith({
        instanceId,
        accountBinding: account.accountBinding,
        idempotencyKey: "fixture-idempotency-key",
      });
      expect(api.refreshProviders).toHaveBeenCalledOnce();
    },
  );
  it("retains an uncertain key through disconnect, reload and retry, even at zero credits", async () => {
    const { api, controller, mint } = fixture();
    vi.mocked(api.consumeCodexResetCredit).mockRejectedValueOnce(new Error("timeout"));
    await controller.load(api, yes);
    controller.requestConfirmation(true);
    await controller.confirm(api, yes);
    expect(controller.getSnapshot().phase).toBe("uncertain");
    controller.disconnect();
    await controller.confirm(api, () => false);
    vi.mocked(api.readCodexResetCredits).mockResolvedValue({
      ...account,
      credits: { availableCount: 0, credits: [] },
    });
    await controller.load(api, yes);
    vi.mocked(api.consumeCodexResetCredit).mockResolvedValue({ outcome: "alreadyRedeemed" });
    await controller.confirm(api, yes);
    expect(mint).toHaveBeenCalledOnce();
    expect(vi.mocked(api.consumeCodexResetCredit).mock.calls[0]).toEqual(
      vi.mocked(api.consumeCodexResetCredit).mock.calls[1],
    );
  });
  it("blocks account switches between confirmation and sending", async () => {
    const { api, controller } = fixture();
    await controller.load(api, yes);
    controller.requestConfirmation(true);
    vi.mocked(api.readCodexResetCredits).mockResolvedValue({
      ...account,
      accountBinding: "fixture-account-b",
    });
    await controller.confirm(api, yes);
    expect(api.consumeCodexResetCredit).not.toHaveBeenCalled();
    expect(controller.getSnapshot().message).toContain("changed");
    await controller.confirm(api, yes);
    expect(api.consumeCodexResetCredit).not.toHaveBeenCalled();
  });
  it("blocks duplicate submits and readiness lost during revalidation", async () => {
    const { api, controller } = fixture();
    await controller.load(api, yes);
    controller.requestConfirmation(true);
    const pending = Promise.withResolvers<typeof account>();
    vi.mocked(api.readCodexResetCredits).mockReturnValue(pending.promise);
    let allowed = true;
    const first = controller.confirm(api, () => allowed);
    await controller.confirm(api, yes);
    allowed = false;
    controller.disconnect();
    pending.resolve(account);
    await first;
    expect(api.consumeCodexResetCredit).not.toHaveBeenCalled();
    expect(controller.getSnapshot().phase).toBe("uncertain");
  });
  it("keeps confirmed success when refresh fails", async () => {
    const { api, controller } = fixture();
    await controller.load(api, yes);
    controller.requestConfirmation(true);
    vi.mocked(api.refreshProviders).mockRejectedValue(new Error("offline"));
    await controller.confirm(api, yes);
    expect(controller.getSnapshot().phase).toBe("settled");
    expect(controller.getSnapshot().attempt).toBeUndefined();
    expect(controller.getSnapshot().message).toContain("could not be refreshed");
  });
  it("hydrates a lost reply after process reload and retries the exact same key", async () => {
    const values = new Map<string, string>();
    const kv = {
      getItem: async (key: string) => values.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: async (key: string) => {
        values.delete(key);
      },
    };
    const { api } = fixture();
    const persistence = { kv, key: "fixture-node/fixture-provider" };
    const original = createResetCreditController(instanceId, () => "original-key", persistence);
    await original.load(api, yes);
    original.requestConfirmation(true);
    vi.mocked(api.consumeCodexResetCredit).mockRejectedValueOnce(
      new Error("reply lost after spending"),
    );
    await original.confirm(api, yes);
    expect(values.size).toBe(1);
    const mint = vi.fn(() => "must-not-be-used");
    const restarted = createResetCreditController(instanceId, mint, persistence);
    restarted.requestConfirmation(true);
    expect(restarted.getSnapshot().phase).toBe("idle");
    await restarted.load(api, yes);
    expect(restarted.getSnapshot().phase).toBe("uncertain");
    vi.mocked(api.consumeCodexResetCredit).mockResolvedValue({ outcome: "alreadyRedeemed" });
    await restarted.confirm(api, yes);
    expect(mint).not.toHaveBeenCalled();
    expect(vi.mocked(api.consumeCodexResetCredit).mock.calls[0]).toEqual(
      vi.mocked(api.consumeCodexResetCredit).mock.calls[1],
    );
    expect(values.size).toBe(0);
  });
  it("never dispatches if the pending key cannot be saved", async () => {
    const { api } = fixture();
    const controller = createResetCreditController(instanceId, () => "fixture-key", {
      key: "scope",
      kv: {
        getItem: async () => null,
        setItem: async () => {
          throw new Error("disk full");
        },
        removeItem: async () => {},
      },
    });
    await controller.load(api, yes);
    controller.requestConfirmation(true);
    await controller.confirm(api, yes);
    expect(api.consumeCodexResetCredit).not.toHaveBeenCalled();
    expect(controller.getSnapshot().attempt?.idempotencyKey).toBe("fixture-key");
  });
  it("rejects saved attempts from another environment before enabling confirmation", async () => {
    const { api } = fixture();
    const controller = createResetCreditController(instanceId, () => "fixture-key", {
      key: "environment-b",
      kv: {
        getItem: async () =>
          JSON.stringify({
            scope: "environment-a",
            attempt: { instanceId, accountBinding: "fixture-a", idempotencyKey: "old-key" },
          }),
        setItem: async () => {},
        removeItem: async () => {},
      },
    });
    await controller.load(api, yes);
    controller.requestConfirmation(true);
    await controller.confirm(api, yes);
    expect(controller.getSnapshot().phase).toBe("error");
    expect(api.consumeCodexResetCredit).not.toHaveBeenCalled();
  });
  it("distinguishes unknown details, empty details, expiry and count", () => {
    expect(resetCreditDetailLines(account)[0]).toContain("only the count");
    expect(resetCreditDetailLines({ credits: { availableCount: 2, credits: [] } })[0]).toContain(
      "No available credit details",
    );
    expect(
      resetCreditDetailLines({
        credits: {
          availableCount: 3,
          credits: [
            {
              id: "fixture",
              grantedAt: 100,
              expiresAt: null,
              status: "available",
              resetType: "codexRateLimits",
            },
          ],
        },
      })[0],
    ).toContain("Does not expire");
  });
});
