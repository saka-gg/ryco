import { describe, expect, it } from "vite-plus/test";

import { canCompileWebAssembly, resolveSyntaxHighlighter } from "./syntaxHighlighterType";

describe("syntax highlighter type", () => {
  it("compiles a SIMD module to decide WASM support instead of trusting the global", () => {
    expect(canCompileWebAssembly()).toBe(true);
    expect(canCompileWebAssembly(null)).toBe(false);
    // A CSP without 'wasm-unsafe-eval' keeps the API and makes compiles throw.
    const BlockedModule = function BlockedModule() {
      throw new WebAssembly.CompileError(
        "WebAssembly.Module(): Compiling or instantiating WebAssembly module violates the following Content Security policy directive",
      );
    } as unknown as typeof WebAssembly.Module;
    expect(canCompileWebAssembly({ Module: BlockedModule, Instance: WebAssembly.Instance })).toBe(
      false,
    );
    // An engine without WASM SIMD (Safari before 16.4) compiles other modules
    // but rejects the SIMD prefix opcode.
    class NoSimdModule extends WebAssembly.Module {
      constructor(bytes: ConstructorParameters<typeof WebAssembly.Module>[0]) {
        const view = ArrayBuffer.isView(bytes)
          ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          : new Uint8Array(bytes);
        if (view.includes(0xfd)) throw new WebAssembly.CompileError("invalid opcode 0xfd");
        super(bytes);
      }
    }
    expect(
      new NoSimdModule(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])),
    ).toBeInstanceOf(NoSimdModule);
    expect(canCompileWebAssembly({ Module: NoSimdModule, Instance: WebAssembly.Instance })).toBe(
      false,
    );
  });

  it("uses Highlights where WASM compiles and Shiki's JS engine where it is blocked or failed", () => {
    expect(resolveSyntaxHighlighter({ canCompileWebAssembly: true, wasmFailed: false })).toBe(
      "highlights",
    );
    expect(resolveSyntaxHighlighter({ canCompileWebAssembly: false, wasmFailed: false })).toBe(
      "shiki-js",
    );
    expect(resolveSyntaxHighlighter({ canCompileWebAssembly: true, wasmFailed: true })).toBe(
      "shiki-js",
    );
  });
});
