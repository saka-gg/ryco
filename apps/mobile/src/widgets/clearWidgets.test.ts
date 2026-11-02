import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo", () => ({ requireOptionalNativeModule: () => null }));

import { clearWidgets } from "./clearWidgets";
import { SUBSCRIPTION_USAGE_WIDGET_KIND, WIDGET_KINDS } from "./widgetKinds";

describe("clearing the widgets on the sign-in screen", () => {
  it("empties every widget the app writes", async () => {
    const native = { clear: vi.fn(async (_kind: string) => undefined) };
    await clearWidgets(native);
    expect(WIDGET_KINDS).toContain(SUBSCRIPTION_USAGE_WIDGET_KIND);
    expect(native.clear.mock.calls).toEqual(WIDGET_KINDS.map((kind) => [kind]));
  });

  it("does nothing in a build without widgets", async () => {
    await expect(clearWidgets()).resolves.toBeUndefined();
  });
});
