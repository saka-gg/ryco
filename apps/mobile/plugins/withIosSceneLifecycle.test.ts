import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const plugin = require("./withIosSceneLifecycle.cjs") as { readonly SCENE_DELEGATE: string };

describe("iOS scene lifecycle", () => {
  it("opens home-screen quick actions as deep links, on launch and while running", () => {
    const swift = plugin.SCENE_DELEGATE;
    expect(swift).toContain("connectionOptions.shortcutItem");
    expect(swift).toContain("performActionFor shortcutItem: UIApplicationShortcutItem");
    expect(swift).toContain('path == "tasks/new"');
    expect(swift).toContain('URL(string: scheme + "://" + path)');
  });

  it("keeps the Swift free of string interpolation a JS template would eat", () => {
    // `\(x)` inside the template literal reaches Swift as `(x)`: a literal, not a value.
    expect(plugin.SCENE_DELEGATE).not.toMatch(/"[^"\n]*\((scheme|path)\)[^"\n]*"/);
  });
});
