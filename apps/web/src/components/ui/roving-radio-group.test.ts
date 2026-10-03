import { describe, expect, it } from "vite-plus/test";

import { rovingRadioTabStop, rovingRadioTargetIndex } from "./roving-radio-group";

const ALL_ENABLED = [false, false, false];

describe("rovingRadioTargetIndex", () => {
  it("steps with both arrow axes and wraps at the ends", () => {
    expect(rovingRadioTargetIndex("ArrowRight", 0, ALL_ENABLED)).toBe(1);
    expect(rovingRadioTargetIndex("ArrowDown", 0, ALL_ENABLED)).toBe(1);
    expect(rovingRadioTargetIndex("ArrowLeft", 1, ALL_ENABLED)).toBe(0);
    expect(rovingRadioTargetIndex("ArrowUp", 1, ALL_ENABLED)).toBe(0);
    expect(rovingRadioTargetIndex("ArrowRight", 2, ALL_ENABLED)).toBe(0);
    expect(rovingRadioTargetIndex("ArrowUp", 0, ALL_ENABLED)).toBe(2);
  });

  it("jumps to the ends with Home and End", () => {
    expect(rovingRadioTargetIndex("Home", 2, ALL_ENABLED)).toBe(0);
    expect(rovingRadioTargetIndex("End", 0, ALL_ENABLED)).toBe(2);
  });

  it("steps over disabled options in the direction of travel", () => {
    const middleDisabled = [false, true, false];
    expect(rovingRadioTargetIndex("ArrowRight", 0, middleDisabled)).toBe(2);
    expect(rovingRadioTargetIndex("ArrowLeft", 2, middleDisabled)).toBe(0);
    const endsDisabled = [true, false, false, true];
    expect(rovingRadioTargetIndex("Home", 2, endsDisabled)).toBe(1);
    expect(rovingRadioTargetIndex("End", 1, endsDisabled)).toBe(2);
    expect(rovingRadioTargetIndex("ArrowDown", 2, endsDisabled)).toBe(1);
    expect(rovingRadioTargetIndex("ArrowUp", 1, endsDisabled)).toBe(2);
  });

  it("stays put when the current option is the only enabled one", () => {
    expect(rovingRadioTargetIndex("ArrowRight", 1, [true, false, true])).toBe(1);
  });

  it("enters at the near end when nothing is current", () => {
    expect(rovingRadioTargetIndex("ArrowRight", -1, ALL_ENABLED)).toBe(0);
    expect(rovingRadioTargetIndex("ArrowLeft", -1, ALL_ENABLED)).toBe(2);
  });

  it("ignores other keys, empty groups and fully disabled groups", () => {
    expect(rovingRadioTargetIndex("Enter", 0, ALL_ENABLED)).toBeNull();
    expect(rovingRadioTargetIndex(" ", 0, ALL_ENABLED)).toBeNull();
    expect(rovingRadioTargetIndex("ArrowRight", 0, [])).toBeNull();
    expect(rovingRadioTargetIndex("Home", 0, [true, true])).toBeNull();
  });
});

describe("rovingRadioTabStop", () => {
  const options = [{ value: "a", disabled: true }, { value: "b" }, { value: "c" }] as const;

  it("is the checked option", () => {
    expect(rovingRadioTabStop(options, "c")).toBe("c");
  });

  it("falls back to the first enabled option when none, or a disabled one, is checked", () => {
    expect(rovingRadioTabStop(options, null)).toBe("b");
    expect(rovingRadioTabStop(options, "a")).toBe("b");
  });

  it("is absent when every option is disabled", () => {
    expect(rovingRadioTabStop([{ value: "a", disabled: true }], "a")).toBeNull();
  });
});
