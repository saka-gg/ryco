import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { WEB_PURE_TEST_FILES } from "./pureTests.ts";

/**
 * Pure-listed files share a module cache and globals with whichever files run
 * after them in the same worker, so a mock, global stub, fake clock, or store
 * write added to one of them fails some other file, in some orders only. These
 * are the APIs the allowlist was audited against; a test that needs one moves
 * to the isolated project.
 */
const SHARED_STATE_APIS: ReadonlyArray<readonly [api: string, pattern: RegExp]> = [
  ["module mocks", /\bvi\.(?:mock|doMock|unmock|hoisted|resetModules)\(/u],
  ["global and environment stubs", /\bvi\.stub(?:Global|Env)\(/u],
  ["spies on shared objects", /\bvi\.spyOn\(/u],
  ["fake timers", /\bvi\.(?:useFakeTimers|setSystemTime)\(/u],
  [
    "DOM and storage globals",
    /\b(?:globalThis|window|document|navigator)\.|\b(?:localStorage|sessionStorage|indexedDB)\b/u,
  ],
  ["environment variables", /\bprocess\.env\b|\bimport\.meta\.env\b/u],
  ["property patching", /\bObject\.defineProperty\(/u],
  ["store state", /\.(?:getState|setState)\(/u],
  ["test-only resets", /\w+ForTests\(/u],
];

function sharedStateApis(source: string): string[] {
  return SHARED_STATE_APIS.filter(([, pattern]) => pattern.test(source)).map(([api]) => api);
}

describe("web pure test allowlist", () => {
  it("lists only files that stay off shared-state APIs", () => {
    const offenders = Object.fromEntries(
      WEB_PURE_TEST_FILES.flatMap((file) => {
        const apis = sharedStateApis(
          readFileSync(path.join(import.meta.dirname, "..", file), "utf8"),
        );
        return apis.length > 0 ? [[file, apis]] : [];
      }),
    );
    expect(offenders).toEqual({});
  });

  it("recognizes each shared-state API", () => {
    expect(sharedStateApis('vi.mock("./store", () => ({}));')).toEqual(["module mocks"]);
    expect(sharedStateApis('vi.stubGlobal("fetch", fetch);')).toEqual([
      "global and environment stubs",
    ]);
    expect(sharedStateApis("vi.spyOn(console, 'warn');")).toEqual(["spies on shared objects"]);
    expect(sharedStateApis("vi.useFakeTimers();")).toEqual(["fake timers"]);
    expect(sharedStateApis("window.location.href;")).toEqual(["DOM and storage globals"]);
    expect(sharedStateApis("localStorage.clear();")).toEqual(["DOM and storage globals"]);
    expect(sharedStateApis("process.env.CI;")).toEqual(["environment variables"]);
    expect(sharedStateApis("Object.defineProperty(target, 'x', {});")).toEqual([
      "property patching",
    ]);
    expect(sharedStateApis("useStore.setState({});")).toEqual(["store state"]);
    expect(sharedStateApis("resetCacheForTests();")).toEqual(["test-only resets"]);
    // Prose about an idle window or a document is not an API use.
    expect(sharedStateApis("// pauses after the idle window; a document id")).toEqual([]);
  });
});
