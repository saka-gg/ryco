import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { Duration } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveAuthClientMetadata,
  DEV_HOME_SESSION_COOKIE_MAX_AGE,
  resolveLegacySessionCookieNames,
  resolveSessionCookieMaxAge,
  resolveSessionCookieName,
  resolveSessionCookieScope,
} from "./utils.ts";

describe("session cookie scope", () => {
  const defaultHome = NodePath.join(NodeOS.homedir(), ".ryco");
  const devUrl = new URL("http://localhost:5733");
  const scope = (input: { readonly mode: "web" | "desktop"; readonly dev?: string | undefined }) =>
    resolveSessionCookieScope({
      mode: input.mode,
      port: 13790,
      devUrl: input.dev === undefined ? undefined : devUrl,
      baseDir: input.dev ?? "/srv/ryco",
      stateDir: NodePath.join(
        input.dev ?? "/srv/ryco",
        input.dev === undefined ? "userdata" : "dev",
      ),
    });

  it("keeps desktop per port and production web on the shared name", () => {
    expect(resolveSessionCookieName(scope({ mode: "desktop" }))).toBe("ryco_session_13790");
    expect(resolveLegacySessionCookieNames(scope({ mode: "desktop" }))).toEqual([
      "t3_session_13790",
    ]);
    expect(resolveSessionCookieName(scope({ mode: "desktop", dev: "/wt/.ryco-dev" }))).toBe(
      "ryco_session_13790",
    );
    expect(resolveSessionCookieName(scope({ mode: "web" }))).toBe("ryco_session");
    expect(resolveLegacySessionCookieNames(scope({ mode: "web" }))).toEqual(["t3_session"]);
    expect(resolveSessionCookieMaxAge(scope({ mode: "web" }))).toBeUndefined();
    expect(resolveSessionCookieMaxAge(scope({ mode: "desktop" }))).toBeUndefined();
  });

  it("gives every dev home its own cookie, whatever port it binds", () => {
    const a = resolveSessionCookieName(scope({ mode: "web", dev: "/wt/a/.ryco-dev" }));
    const b = resolveSessionCookieName(scope({ mode: "web", dev: "/wt/b/.ryco-dev" }));
    expect(a).toMatch(/^ryco_session_dev_[0-9a-f]{8}$/);
    expect(b).not.toBe(a);
    expect(
      resolveSessionCookieName({
        mode: "web",
        port: 14020,
        dev: { stateDir: NodePath.join("/wt/a/.ryco-dev", "dev"), defaultHome: false },
      }),
    ).toBe(a);
  });

  it("accepts the old shared cookie only on the default dev home", () => {
    expect(resolveLegacySessionCookieNames(scope({ mode: "web", dev: defaultHome }))).toEqual([
      "ryco_session",
      "t3_session",
    ]);
    expect(resolveLegacySessionCookieNames(scope({ mode: "web", dev: "/wt/a/.ryco-dev" }))).toEqual(
      [],
    );
  });

  it("caps the cookie life of a worktree dev home only", () => {
    expect(resolveSessionCookieMaxAge(scope({ mode: "web", dev: "/wt/a/.ryco-dev" }))).toBe(
      DEV_HOME_SESSION_COOKIE_MAX_AGE,
    );
    expect(Duration.toDays(DEV_HOME_SESSION_COOKIE_MAX_AGE)).toBe(7);
    expect(resolveSessionCookieMaxAge(scope({ mode: "web", dev: defaultHome }))).toBeUndefined();
  });
});

describe("deriveAuthClientMetadata", () => {
  it("labels Electron user agents as Electron instead of Chrome", () => {
    const metadata = deriveAuthClientMetadata({
      request: {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ryco/0.0.15 Chrome/136.0.7103.93 Electron/36.3.2 Safari/537.36",
        },
        source: {
          remoteAddress: "::ffff:127.0.0.1",
        },
      } as never,
    });

    expect(metadata).toMatchObject({
      browser: "Electron",
      deviceType: "desktop",
      ipAddress: "127.0.0.1",
      os: "macOS",
    });
  });
});
