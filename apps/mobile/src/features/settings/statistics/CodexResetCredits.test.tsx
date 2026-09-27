import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EnvironmentId, ProviderInstanceId } from "@ryco/contracts";
import { getResetCreditController, type ResetCreditApi } from "@ryco/client-runtime/usage";
vi.mock("../../../platform/kv", () => ({ mobileKV: {} }));
vi.mock("react-native", () => ({ View: "div", Pressable: "button" }));
vi.mock("../../../components/AppText", () => ({ AppText: "span" }));
vi.mock("../../../connection/environmentApi", () => ({ readRpcClient: vi.fn() }));
vi.mock("../../../lib/uuid", () => ({ uuidv4: () => "fixture-key" }));
vi.mock("./StatisticsParts", () => ({ Note: "p" }));
import { CodexResetCredits } from "./CodexResetCredits";

describe("native reset credit presentation", () => {
  it("renders shared confirmation and disconnected retry state without consuming", async () => {
    const environmentId = EnvironmentId.make("fixture-node");
    const instanceId = ProviderInstanceId.make("fixture-codex");
    const controller = getResetCreditController(environmentId, instanceId, () => "fixture-key");
    const api: ResetCreditApi = {
      readCodexResetCredits: async () => ({
        accountBinding: "fixture-a",
        accountLabel: "fixture@example.test",
        credits: { availableCount: 3, credits: [] },
      }),
      consumeCodexResetCredit: vi.fn(async () => {
        throw new Error("timeout");
      }),
      refreshProviders: async () => ({}),
    };
    await controller.load(api, () => true);
    controller.requestConfirmation(true);
    let html = renderToStaticMarkup(
      <CodexResetCredits environmentId={environmentId} instanceId={instanceId} allowed />,
    );
    expect(html).toContain("Banked resets · 3");
    expect(html).toContain("No available credit details");
    expect(html).toContain("fixture@example.test");
    expect(html).toContain("Confirm redemption");
    expect(api.consumeCodexResetCredit).not.toHaveBeenCalled();
    await controller.confirm(api, () => true);
    controller.disconnect();
    html = renderToStaticMarkup(
      <CodexResetCredits environmentId={environmentId} instanceId={instanceId} allowed={false} />,
    );
    expect(html).toContain("Retry same reset attempt");
    expect(html).toContain("disabled");
  });
});
