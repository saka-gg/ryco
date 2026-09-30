import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfigMap,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveNativeUsageSources } from "./usageNativeSources.ts";

const instance = (
  id: string,
  driver: string,
  environment: Record<string, string> = {},
  config: unknown = {},
) =>
  ({
    [ProviderInstanceId.make(id)]: {
      driver: ProviderDriverKind.make(driver),
      config,
      environment: Object.entries(environment).map(([name, value]) => ({
        name,
        value,
        sensitive: false,
      })),
    },
  }) as ProviderInstanceConfigMap;

describe("native usage source authority", () => {
  it("scopes mixed accounts to configured XDG roots without adding default history", () => {
    const sources = resolveNativeUsageSources(
      {
        ...instance("personal", "opencode", { XDG_DATA_HOME: "/fixture/personal" }),
        ...instance("work", "opencode", { XDG_DATA_HOME: "/fixture/work" }),
      },
      { HOME: "/fixture/default" },
    );
    expect(sources.map((source) => source.scanRoots)).toEqual([
      ["/fixture/personal/opencode"],
      ["/fixture/work/opencode"],
    ]);
    expect(sources.map((source) => source.identityRoot)).toEqual([
      "/fixture/personal/opencode/opencode.db",
      "/fixture/work/opencode/opencode.db",
    ]);
  });
  it("respects explicit databases and prevents legacy account fallback", () => {
    const [source] = resolveNativeUsageSources(
      instance("work", "opencode", { OPENCODE_DB: "/fixture/work/account.db" }),
      { HOME: "/fixture/default" },
    );
    expect(source).toMatchObject({
      identityRoot: "/fixture/work/account.db",
      databasePath: "/fixture/work/account.db",
      scanRoots: ["/fixture/work"],
      allowLegacy: false,
    });
  });
  it("rejects invalid and in-memory roots and never queries remote instances locally", () => {
    expect(
      resolveNativeUsageSources(instance("work", "opencode", { XDG_DATA_HOME: "relative" }), {
        HOME: "/fixture/home",
      })[0]?.unsupportedCode,
    ).toBe("history-root-invalid");
    expect(
      resolveNativeUsageSources(instance("work", "opencode", { OPENCODE_DB: ":memory:" }), {
        HOME: "/fixture/home",
      })[0]?.unsupportedCode,
    ).toBe("opencode-database-unavailable");
    expect(
      resolveNativeUsageSources(
        instance("work", "opencode", {}, { serverUrl: "http://fixture.invalid" }),
      )[0],
    ).toMatchObject({ scanRoots: [], unsupportedCode: "opencode-remote-history-unavailable" });
  });
  it("does not touch credentials for Cursor, even with credential getters", () => {
    const environment = {
      HOME: "/fixture/home",
      get CURSOR_API_KEY(): string {
        throw new Error("credentials must not be read");
      },
    };
    expect(resolveNativeUsageSources(instance("cursor", "cursor"), environment)[0]).toMatchObject({
      provider: "cursor",
      scanRoots: [],
      unsupportedCode: "cursor-export-not-configured",
    });
  });
  it("does not add unrelated or disabled sources", () => {
    const instances = instance("work", "opencode");
    expect(
      resolveNativeUsageSources({
        ...instances,
        [ProviderInstanceId.make("work")]: {
          ...instances[ProviderInstanceId.make("work")]!,
          enabled: false,
        },
      }),
    ).toEqual([]);
  });
});

it("normalizes default and explicit references to the same OpenCode store", () => {
  const env = { HOME: "/fixture/home", XDG_DATA_HOME: "/fixture/data" };
  const defaults = resolveNativeUsageSources(instance("default", "opencode"), env)[0]!;
  const explicit = resolveNativeUsageSources(
    instance("explicit", "opencode", { OPENCODE_DB: defaults.databasePath! }),
    env,
  )[0]!;
  expect(defaults.identityRoot).toBe(explicit.identityRoot);
  expect(defaults.databasePath).toBe(explicit.databasePath);
});
