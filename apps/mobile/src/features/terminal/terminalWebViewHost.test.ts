// The app's `tsconfig` is the react-native one, which resolves no Node builtins;
// this test runs under Node, so it pulls the types in for itself.
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { TERMINAL_WEBVIEW_SECURITY_PROPS } from "./terminalRendererDocument";

const source = readFileSync(join(import.meta.dirname, "TerminalWebView.tsx"), "utf8");

describe("terminal WebView host", () => {
  it("loads only the app-owned string document and uses every security fence", () => {
    expect(source).toContain("source={{ html: document }}");
    expect(source).toContain('originWhitelist={["about:*"]}');
    expect(source).not.toContain("source={{ uri:");
    expect(source).not.toMatch(/injectJavaScript|injectedJavaScript/u);
    for (const key of Object.keys(TERMINAL_WEBVIEW_SECURITY_PROPS)) {
      expect(source, key).toMatch(
        new RegExp(`${key}=\\{\\s*TERMINAL_WEBVIEW_SECURITY_PROPS\\.${key}\\s*\\}`, "u"),
      );
    }
  });

  it("refuses navigation and windows and recovers from a lost content process", () => {
    expect(source).toContain("isAllowedTerminalRendererNavigation(request.url)");
    expect(source).toContain("onOpenWindow={dropWindowRequest}");
    expect(source).toContain("onContentProcessDidTerminate={reportFailure}");
    expect(source).toContain("onRenderProcessGone={reportFailure}");
  });
});
