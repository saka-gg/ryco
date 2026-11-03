// The app's `tsconfig` is the react-native one, which resolves no Node builtins;
// this test runs under Node, so it pulls the types in for itself.
/// <reference types="node" />
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import {
  buildTerminalRendererDocument,
  TERMINAL_RENDERER_DOCUMENT_PATH,
  terminalRendererContentSecurityPolicy,
} from "../../../scripts/build-terminal-renderer.mts";
import {
  isAllowedTerminalRendererNavigation,
  TERMINAL_WEBVIEW_SECURITY_PROPS,
} from "./terminalRendererDocument";

const checkedIn = readFileSync(TERMINAL_RENDERER_DOCUMENT_PATH, "utf8");

function inlineScript(document: string): string {
  const script = document.match(/<script>([\s\S]*)<\/script>/u)?.[1];
  if (script === undefined) throw new Error("The renderer document has no inline script.");
  return script;
}

describe("terminal renderer document", () => {
  it("is exactly what the generator builds from the current sources and dependencies", async () => {
    // Regenerate with `bun run --cwd apps/mobile build:terminal-renderer`.
    expect(await buildTerminalRendererDocument()).toBe(checkedIn);
  }, 60_000);

  it("admits only its own inline script by hash and denies every other resource class", () => {
    const csp = checkedIn.match(/Content-Security-Policy" content="([^"]+)"/u)?.[1];
    const digest = createHash("sha256").update(inlineScript(checkedIn), "utf8").digest("base64");
    expect(csp).toBe(terminalRendererContentSecurityPolicy(digest));
    for (const directive of [
      "default-src 'none'",
      "connect-src 'none'",
      "img-src 'none'",
      "media-src 'none'",
      "font-src 'none'",
      "frame-src 'none'",
      "object-src 'none'",
      "worker-src 'none'",
      "manifest-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
    ]) {
      expect(csp).toContain(directive);
    }
    expect(csp).not.toContain("unsafe-eval");
    expect(csp?.match(/script-src [^;]+/u)?.[0]).toBe(`script-src 'sha256-${digest}'`);
    expect(checkedIn.match(/<script/gu)).toHaveLength(1);
    expect(checkedIn).not.toMatch(/<script[^>]+src=/u);
  });

  it("pins its inputs and keeps the bridge free of sockets, storage and markup sinks", () => {
    expect(checkedIn).toContain("xterm 6.0.0; fit 0.11.0");
    const script = inlineScript(checkedIn);
    expect(script).toContain("ReactNativeWebView");
    for (const forbidden of [
      "new WebSocket",
      "XMLHttpRequest",
      "fetch(",
      "localStorage",
      "sessionStorage",
      "indexedDB",
      "innerHTML",
      "new Function",
      "eval(",
    ]) {
      expect(script, forbidden).not.toContain(forbidden);
    }
  });

  it("turns off text assistance on the input the software keyboard types into", () => {
    const script = inlineScript(checkedIn);
    for (const [name, value] of [
      ["autocomplete", "off"],
      ["autocorrect", "off"],
      ["autocapitalize", "none"],
      ["spellcheck", "false"],
    ]) {
      const quote = "[\"'`]";
      expect(script, name).toMatch(
        new RegExp(`setAttribute\\(${quote}${name}${quote},${quote}${value}${quote}\\)`, "u"),
      );
    }
  });

  it("refuses all navigation beyond the initial about document", () => {
    expect(isAllowedTerminalRendererNavigation("")).toBe(true);
    expect(isAllowedTerminalRendererNavigation("about:blank")).toBe(true);
    expect(isAllowedTerminalRendererNavigation("about:srcdoc")).toBe(false);
    expect(isAllowedTerminalRendererNavigation("https://example.test")).toBe(false);
    expect(isAllowedTerminalRendererNavigation("file:///private/terminal.html")).toBe(false);
    expect(isAllowedTerminalRendererNavigation("data:text/html,hello")).toBe(false);
    expect(isAllowedTerminalRendererNavigation("ryco://threads")).toBe(false);
  });

  it("keeps the load-bearing WebView capabilities disabled", () => {
    expect(TERMINAL_WEBVIEW_SECURITY_PROPS).toEqual({
      javaScriptEnabled: true,
      incognito: true,
      cacheEnabled: false,
      domStorageEnabled: false,
      allowFileAccess: false,
      allowFileAccessFromFileURLs: false,
      allowUniversalAccessFromFileURLs: false,
      sharedCookiesEnabled: false,
      thirdPartyCookiesEnabled: false,
      setSupportMultipleWindows: false,
      allowsInlineMediaPlayback: false,
      mediaPlaybackRequiresUserAction: true,
      allowsLinkPreview: false,
      dataDetectorTypes: "none",
    });
  });
});
