/// <reference types="node" />
/**
 * Shared by the generated WebView documents (`build-terminal-renderer.mts`,
 * `build-device-stream-renderer.mts`): bundle one renderer entry into a
 * minified IIFE that can sit inline in a `<script>`, and hash it for the
 * document's Content Security Policy.
 */
import { createHash } from "node:crypto";
import { build } from "vite-plus";

export function escapeInlineScript(script: string): string {
  return script.replaceAll(/<\/script/giu, "<\\/script");
}

export function escapeInlineStyle(style: string): string {
  return style.replaceAll(/<\/style/giu, "<\\/style");
}

/** The CSP `script-src` hash of an inline script, base64 SHA-256. */
export function inlineScriptHash(script: string): string {
  return createHash("sha256").update(script, "utf8").digest("base64");
}

export async function bundleInlineRendererScript(options: {
  readonly root: string;
  readonly entry: string;
  readonly name: string;
}): Promise<string> {
  const result = await build({
    configFile: false,
    envFile: false,
    logLevel: "silent",
    root: options.root,
    mode: "production",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      write: false,
      emptyOutDir: false,
      copyPublicDir: false,
      minify: true,
      sourcemap: false,
      reportCompressedSize: false,
      target: "es2020",
      lib: {
        entry: options.entry,
        formats: ["iife"],
        name: options.name,
        fileName: () => "renderer.js",
      },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  for (const output of outputs) {
    if (!("output" in output)) continue;
    for (const chunk of output.output) {
      if (chunk.type === "chunk" && chunk.isEntry) return chunk.code.trim();
    }
  }
  throw new Error(`The ${options.name} bundle produced no entry chunk.`);
}
