import { assert, describe, it } from "@effect/vitest";

import {
  findSearchField,
  flattenUiTree,
  isTransientUiTreeError,
  layoutStableToken,
  mentions,
  normalizedTapPoint,
  readUiTree,
  rootLabel,
  showsAnotherApp,
  visibleLabels,
} from "./device-helper-smoke-ui.ts";

/** Shaped like the helper's `describe-ui` answer for Settings' root list. */
const settingsTree = readUiTree({
  role: "Application",
  label: "Settings",
  frame: { x: 0, y: 0, width: 402, height: 874 },
  children: [
    {
      role: "NavigationBar",
      label: "Settings",
      frame: { x: 0, y: 50, width: 402, height: 100 },
      children: [
        {
          role: "SearchField",
          label: "Search",
          frame: { x: 16, y: 100, width: 370, height: 36 },
        },
      ],
    },
    {
      role: "Button",
      label: "Wi-Fi",
      value: "Off",
      frame: { x: 0, y: 200, width: 402, height: 44 },
    },
    // The helper leaves out a frame it cannot represent (NaN from SwiftUI).
    { role: "StaticText", label: "Unframed" },
    "not a node",
  ],
});

/**
 * iOS 27 Settings, as the helper described it on a live simulator (trimmed):
 * the "Search" row comes before the search field at the bottom, which has no
 * label of its own.
 */
const settingsIos27Tree = readUiTree({
  role: "Application",
  label: "Settings",
  frame: { x: 0, y: 0, width: 402, height: 874 },
  children: [
    { role: "Heading", label: "Settings", frame: { x: 16, y: 120, width: 215, height: 41 } },
    {
      role: "Group",
      identifier: "com.apple.settings.sidebar.collectionView",
      frame: { x: 0, y: 0, width: 402, height: 874 },
      children: [
        {
          role: "Button",
          label: "Search",
          identifier: "com.apple.settings.search",
          frame: { x: 16, y: 730, width: 370, height: 52 },
        },
      ],
    },
    { role: "TextField", value: "Search", frame: { x: 28, y: 808, width: 346, height: 28 } },
  ],
});

/** The iOS 27 home screen: SpringBoard's root label is a single space. */
const springBoardTree = readUiTree({
  role: "Application",
  label: " ",
  frame: { x: 0, y: 0, width: 402, height: 874 },
  children: [
    { role: "Button", label: "Maps", frame: { x: 214, y: 289, width: 68, height: 91 } },
    { role: "Button", label: "Settings", frame: { x: 291, y: 389, width: 98, height: 91 } },
  ],
});

describe("readUiTree and flattenUiTree", () => {
  it("lists every node depth first, as the server reads them", () => {
    assert.deepStrictEqual(
      flattenUiTree(settingsTree).map((node) => node.role),
      ["Application", "NavigationBar", "SearchField", "Button", "StaticText", "Unknown"],
    );
  });

  it("reads a tree that is not an object as an empty node", () => {
    const empty = readUiTree(undefined);
    assert.strictEqual(empty.role, "Unknown");
    assert.deepStrictEqual(flattenUiTree(empty), [empty]);
  });
});

describe("rootLabel", () => {
  it("names the frontmost app", () => {
    assert.strictEqual(rootLabel(settingsTree), "Settings");
    assert.isUndefined(rootLabel(readUiTree({ role: "Application" })));
    assert.isUndefined(rootLabel(readUiTree(null)));
  });

  it("reads SpringBoard's blank root label as no name", () => {
    assert.isUndefined(rootLabel(springBoardTree));
  });
});

describe("showsAnotherApp", () => {
  it("accepts the home screen after Settings", () => {
    assert.isTrue(showsAnotherApp(springBoardTree, "Settings"));
  });

  it("rejects Settings itself and a bare transient answer", () => {
    assert.isFalse(showsAnotherApp(settingsIos27Tree, "Settings"));
    assert.isFalse(showsAnotherApp(readUiTree({ role: "Application", label: " " }), "Settings"));
    // Children without labels or frames are nothing a tap could land on.
    assert.isFalse(
      showsAnotherApp(
        readUiTree({ role: "Application", children: [{ role: "Group" }, { label: "x" }] }),
        "Settings",
      ),
    );
  });
});

describe("isTransientUiTreeError", () => {
  it("matches only the helper's no-frontmost-application error", () => {
    assert.isTrue(
      isTransientUiTreeError(
        new Error(
          "accessibility tree unavailable: no frontmost application (SpringBoard may still be starting)",
        ),
      ),
    );
    assert.isFalse(isTransientUiTreeError(new Error("accessibility translator unavailable")));
    assert.isFalse(isTransientUiTreeError("no frontmost application"));
  });
});

describe("findSearchField", () => {
  it("finds a search field by role", () => {
    assert.strictEqual(findSearchField(settingsTree)?.label, "Search");
  });

  it("finds one by its label when the role is generic, and skips untappable matches", () => {
    const root = readUiTree({
      role: "Application",
      children: [
        { role: "TextField", label: "Name" },
        { role: "Other", label: "search", frame: { x: 0, y: 50, width: 100, height: 30 } },
      ],
    });
    assert.strictEqual(findSearchField(root)?.role, "Other");
  });

  it("prefers the field over a row labelled Search listed before it (iOS 27 Settings)", () => {
    const field = findSearchField(settingsIos27Tree);
    assert.strictEqual(field?.role, "TextField");
    assert.deepStrictEqual(normalizedTapPoint(field!, 402, 874), { x: 201 / 402, y: 822 / 874 });
  });

  it("returns undefined when there is none", () => {
    assert.isUndefined(findSearchField(readUiTree({ role: "Application", label: "Home" })));
  });
});

describe("normalizedTapPoint", () => {
  it("normalizes the frame centre to the screen", () => {
    const field = findSearchField(settingsTree)!;
    assert.deepStrictEqual(normalizedTapPoint(field, 402, 874), { x: 201 / 402, y: 118 / 874 });
  });

  it("taps a control's own activation point, as the server does", () => {
    const toggle = readUiTree({
      role: "CheckBox",
      frame: { x: 36, y: 184, width: 330, height: 28 },
      activationPoint: { x: 336.5, y: 198 },
    });
    assert.deepStrictEqual(normalizedTapPoint(toggle, 402, 874), {
      x: 336.5 / 402,
      y: 198 / 874,
    });
  });

  it("gives up off screen or without a screen size", () => {
    const below = readUiTree({ frame: { x: 0, y: 900, width: 402, height: 44 } });
    assert.isUndefined(normalizedTapPoint(below, 402, 874));
    const field = findSearchField(settingsTree)!;
    assert.isUndefined(normalizedTapPoint(field, 0, 874));
  });
});

describe("layoutStableToken", () => {
  it("uses only letters every common layout puts on the same key", () => {
    for (let run = 0; run < 50; run += 1) {
      assert.match(layoutStableToken(), /^[bcdefghijklnoprstuvx]{6}$/u);
    }
    // No q, w, y, z, a or m: QWERTZ and AZERTY move them.
    assert.strictEqual(
      layoutStableToken(() => 0),
      "bbbbbb",
    );
    assert.strictEqual(
      layoutStableToken(() => 0.999_999, 3),
      "xxx",
    );
  });
});

describe("mentions and visibleLabels", () => {
  it("matches a value or label case-insensitively", () => {
    const root = readUiTree({
      role: "Application",
      children: [{ role: "SearchField", label: "Search", value: "WiFi" }],
    });
    assert.isTrue(mentions(root, "wifi"));
    assert.isFalse(mentions(settingsTree, "bluetooth"));
  });

  it("lists distinct tappable labels up to a limit", () => {
    assert.deepStrictEqual(visibleLabels(settingsTree), ["Settings", "Search", "Wi-Fi"]);
    assert.deepStrictEqual(visibleLabels(settingsTree, 2), ["Settings", "Search"]);
  });
});
