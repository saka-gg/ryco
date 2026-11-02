import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  native: null as null | { readonly activitiesEnabled: () => boolean },
  preferences: {} as { liveActivitiesEnabled?: boolean },
}));
vi.mock("../../widgets/rycoWidgetsNative", () => ({ rycoWidgetsNative: () => state.native }));
vi.mock("../../state/preferencesStore", () => ({
  usePreferences: () => state.preferences,
  updatePreferences: () => undefined,
}));
vi.mock("./components/SettingsSwitchRow", () => ({
  SettingsSwitchRow: (props: {
    readonly label: string;
    readonly detail: string;
    readonly value: boolean;
    readonly disabled?: boolean;
  }) => (
    <p data-value={String(props.value)} data-disabled={String(props.disabled === true)}>
      {props.label}: {props.detail}
    </p>
  ),
}));

import { LIVE_ACTIVITY_DETAIL, LiveActivitySettings } from "./LiveActivitySettings";

describe("the Live Activity switch", () => {
  beforeEach(() => {
    state.native = null;
    state.preferences = {};
  });

  it("is missing in a build without the widget extension", () => {
    expect(renderToStaticMarkup(<LiveActivitySettings />)).toBe("");
  });

  it("is off until turned on, and says it is current only while Ryco runs and shows titles locked", () => {
    state.native = { activitiesEnabled: () => true };
    const markup = renderToStaticMarkup(<LiveActivitySettings />);
    expect(markup).toContain('data-value="false"');
    expect(markup).toContain("Live Activity");
    expect(LIVE_ACTIVITY_DETAIL).toContain("stays current only while Ryco runs");
    expect(LIVE_ACTIVITY_DETAIL).toContain("titles show on a locked phone");
    state.preferences = { liveActivitiesEnabled: true };
    expect(renderToStaticMarkup(<LiveActivitySettings />)).toContain('data-value="true"');
  });

  it("points to iOS Settings when Live Activities are off for Ryco there", () => {
    state.native = { activitiesEnabled: () => false };
    const markup = renderToStaticMarkup(<LiveActivitySettings />);
    expect(markup).toContain("Allow Live Activities for Ryco in iOS Settings.");
    expect(markup).toContain('data-disabled="true"');
  });
});
