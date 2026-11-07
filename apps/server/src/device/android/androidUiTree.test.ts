import { describe, expect, it } from "vitest";

import { formatUiSnapshot } from "../deviceUiSnapshot.ts";
import { androidRole, androidUiRoot, parseUiHierarchyXml } from "./androidUiTree.ts";

const node = (attributes: Record<string, string>, children = "") => {
  const defaults: Record<string, string> = {
    text: "",
    "resource-id": "",
    class: "android.view.View",
    package: "com.example.app",
    "content-desc": "",
    checkable: "false",
    checked: "false",
    clickable: "false",
    enabled: "true",
    selected: "false",
    bounds: "[0,0][100,100]",
  };
  const attrs = Object.entries({ ...defaults, ...attributes })
    .map(([key, value]) => `${key}="${value}"`)
    .join(" ");
  return children ? `<node ${attrs}>${children}</node>` : `<node ${attrs} />`;
};

const hierarchy = (body: string) =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="1">${body}</hierarchy>`;

describe("Android UI tree", () => {
  it("parses entities and quoted '>' in attributes", () => {
    const { rotation, nodes } = parseUiHierarchyXml(
      hierarchy(node({ text: "a &gt; b &amp; &quot;c&quot; > d &#10;e &#x1F600;" })),
    );
    expect(rotation).toBe(1);
    expect(nodes[0]!.attributes.text).toBe('a > b & "c" > d \ne 😀');
    expect(() => parseUiHierarchyXml("UI hierchary dumped to: /dev/tty")).toThrow("no hierarchy");
  });

  it("maps widget classes to the iOS role names", () => {
    expect(androidRole("android.widget.Button")).toBe("Button");
    expect(androidRole("com.google.android.material.button.MaterialButton")).toBe("Button");
    expect(androidRole("android.widget.EditText")).toBe("TextField");
    expect(androidRole("android.view.View", { editable: true })).toBe("TextField");
    expect(androidRole("androidx.appcompat.widget.SwitchCompat")).toBe("Switch");
    expect(androidRole("android.widget.CheckBox")).toBe("CheckBox");
    expect(androidRole("android.widget.TextView")).toBe("StaticText");
    expect(androidRole("android.widget.ImageView")).toBe("Image");
    expect(androidRole("androidx.recyclerview.widget.RecyclerView")).toBe("ScrollArea");
    expect(androidRole("android.widget.FrameLayout")).toBe("Group");
  });

  it("folds a clickable row's text into one labelled button and keeps its switch", () => {
    const row = node(
      { class: "android.widget.LinearLayout", clickable: "true", bounds: "[0,200][1080,400]" },
      [
        node(
          { class: "android.widget.RelativeLayout", bounds: "[40,220][800,380]" },
          node({ class: "android.widget.TextView", text: "Wi-Fi", bounds: "[40,220][800,300]" }) +
            node({
              class: "android.widget.TextView",
              text: "Connected",
              bounds: "[40,300][800,380]",
            }),
        ),
        node({
          class: "android.widget.Switch",
          checkable: "true",
          checked: "true",
          bounds: "[900,250][1040,350]",
        }),
      ].join(""),
    );
    const root = androidUiRoot(
      hierarchy(node({ class: "android.widget.FrameLayout", bounds: "[0,0][1080,2280]" }, row)),
      { width: 1080, height: 2280 },
    );
    expect(root).toMatchObject({ role: "Application", label: "com.example.app" });
    const text = formatUiSnapshot(root);
    expect(text).toContain('Switch value="on" (970,300)');
    expect(text).toContain('app "com.example.app"');
    const lines = text.split("\n").filter((line) => line.startsWith("@e"));
    expect(lines).toHaveLength(2);
  });

  it("labels fields by hint, values by text, and marks disabled and selected", () => {
    const root = androidUiRoot(
      hierarchy(
        node(
          { class: "android.widget.FrameLayout", bounds: "[0,0][1080,2280]" },
          node({
            class: "android.widget.EditText",
            hint: "Email",
            text: "me@example.com",
            bounds: "[0,0][1080,100]",
          }) +
            node({
              class: "android.widget.Button",
              text: "Send",
              enabled: "false",
              bounds: "[0,100][1080,200]",
            }) +
            node({
              class: "android.widget.TextView",
              text: "Inbox",
              clickable: "true",
              selected: "true",
              bounds: "[0,200][540,300]",
            }) +
            node({
              class: "android.widget.ImageButton",
              "content-desc": "Menu",
              bounds: "[0,300][100,400]",
            }),
        ),
      ),
      null,
    );
    const text = formatUiSnapshot(root);
    expect(text).toContain('TextField "Email" value="me@example.com" (540,50)');
    expect(text).toContain('Button "Send" value="disabled"');
    expect(text).toContain('Button "Inbox" value="selected"');
    expect(text).toContain('Button "Menu" (50,350)');
    expect(root.frame).toEqual({ x: 0, y: 0, width: 1080, height: 2280 });
  });
});
