import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ alert: vi.fn() }));

vi.mock("react-native", () => ({
  Alert: { alert: mocks.alert },
  Modal: "Modal",
  Platform: { OS: "ios" },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  View: "View",
}));
vi.mock("../lib/useThemeColor", () => ({ useThemeColor: () => "#000000" }));
vi.mock("../lib/cn", () => ({ cn: (...values: ReadonlyArray<unknown>) => values.join(" ") }));
vi.mock("./AppText", () => ({ AppText: "AppText" }));

import { showConfirmDialog } from "./ConfirmDialogHost";

describe("showConfirmDialog", () => {
  it("uses an actionable native destructive alert on iOS", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();

    showConfirmDialog({
      title: "Sign out of your Hub?",
      message: "This device's Hub session ends.",
      confirmText: "Sign out",
      destructive: true,
      onCancel,
      onConfirm,
    });

    expect(mocks.alert).toHaveBeenCalledTimes(1);
    const [title, message, actions] = mocks.alert.mock.calls[0] as [
      string,
      string,
      ReadonlyArray<{
        readonly text: string;
        readonly style: string;
        readonly onPress?: () => void;
      }>,
    ];
    expect(title).toBe("Sign out of your Hub?");
    expect(message).toBe("This device's Hub session ends.");
    expect(actions.map(({ text, style }) => ({ text, style }))).toEqual([
      { text: "Cancel", style: "cancel" },
      { text: "Sign out", style: "destructive" },
    ]);

    actions[1]?.onPress?.();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });
});
