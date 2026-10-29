import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerConfig,
  type ServerProvider,
} from "@ryco/contracts";
import { PROVIDER_SIGN_IN_FORBIDDEN } from "@ryco/client-runtime/state/providerSignIn";
import { PROVIDER_SIGN_IN_DRIVERS } from "@ryco/shared/providerSignIn";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProviderAccounts,
  lastHttpsUrl,
  providerSignInAccess,
  type ProviderAccountsEnvironment,
} from "./providerAccountsModel";

const STUDIO = EnvironmentId.make("studio");

function environment(
  patch: Partial<ProviderAccountsEnvironment> = {},
): ProviderAccountsEnvironment {
  return {
    environmentId: STUDIO,
    label: "Studio",
    connectionState: "connected",
    role: "owner",
    mutationReady: true,
    ...patch,
  };
}

function provider(
  driver: string,
  auth: ServerProvider["auth"],
  patch: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: auth.status === "authenticated" ? "ready" : "error",
    auth,
    checkedAt: "2026-10-28T10:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...patch,
  };
}

function config(
  providers: readonly ServerProvider[],
  instances: Record<string, ProviderInstanceConfig> = {},
): Pick<ServerConfig, "providers" | "settings"> {
  return {
    providers,
    settings: { ...DEFAULT_SERVER_SETTINGS, providerInstances: instances },
  } as Pick<ServerConfig, "providers" | "settings">;
}

const SIGNED_OUT = { status: "unauthenticated" } as const;

function rowsOf(
  providers: readonly ServerProvider[],
  instances: Record<string, ProviderInstanceConfig> = {},
  env = environment(),
) {
  return buildProviderAccounts({
    environments: [env],
    configs: new Map([[env.environmentId, config(providers, instances)]]),
  }).nodes[0]!.rows!;
}

describe("providerSignInAccess", () => {
  it("lets owners of a mutation-ready connection sign in", () => {
    expect(providerSignInAccess(environment())).toEqual({ allowed: true, reason: null });
    // A node whose role is not known yet is asked; it refuses a session it does not own.
    expect(providerSignInAccess(environment({ role: undefined })).allowed).toBe(true);
  });

  it("refuses the roles the node refuses", () => {
    for (const role of ["viewer", "operator", "client"] as const) {
      expect(providerSignInAccess(environment({ role }))).toEqual({
        allowed: false,
        reason: PROVIDER_SIGN_IN_FORBIDDEN,
      });
    }
    // A viewer's connection reads as read-only; the role is the reason that matters.
    expect(
      providerSignInAccess(environment({ role: "viewer", connectionState: "read-only" })).reason,
    ).toBe(PROVIDER_SIGN_IN_FORBIDDEN);
  });

  it("waits for a live connection that takes changes", () => {
    const waiting = { allowed: false, reason: "Available when Studio is connected" };
    expect(providerSignInAccess(environment({ connectionState: "reconnecting" }))).toEqual(waiting);
    expect(providerSignInAccess(environment({ mutationReady: false }))).toEqual(waiting);
  });
});

describe("buildProviderAccounts", () => {
  it("lists connected nodes' instances and names the others", () => {
    const view = buildProviderAccounts({
      environments: [
        environment(),
        environment({ environmentId: EnvironmentId.make("m4"), label: "M4" }),
        environment({
          environmentId: EnvironmentId.make("laptop"),
          label: "Laptop",
          connectionState: "offline",
        }),
      ],
      configs: new Map([[STUDIO, config([provider("codex", SIGNED_OUT)])]]),
    });
    expect(view.nodes.map((node) => [node.label, node.rows?.length ?? null])).toEqual([
      ["Studio", 1],
      // Connected, but its providers have not arrived yet.
      ["M4", null],
    ]);
    expect(view.offline).toEqual(["Laptop"]);
  });

  it("offers a sign-in to an owner for an instance that needs one", () => {
    const [codex] = rowsOf([provider("codex", SIGNED_OUT)]);
    expect(codex).toMatchObject({
      displayName: "Codex",
      status: "Not signed in",
      detail: "Tap to sign in.",
      canSignIn: true,
      instanceEnabled: true,
    });
  });

  it("shows why a session that may not sign in cannot", () => {
    const [codex] = rowsOf([provider("codex", SIGNED_OUT)], {}, environment({ role: "operator" }));
    expect(codex).toMatchObject({ canSignIn: false, detail: PROVIDER_SIGN_IN_FORBIDDEN });
    const [offline] = rowsOf(
      [provider("codex", SIGNED_OUT)],
      {},
      environment({ mutationReady: false }),
    );
    expect(offline).toMatchObject({
      canSignIn: false,
      detail: "Available when Studio is connected",
    });
  });

  it("reports signed-in, ready and stopped instances without offering a sign-in", () => {
    const rows = rowsOf([
      provider("codex", { status: "authenticated", email: "a@example.com", label: "ChatGPT Pro" }),
      provider(
        "codex",
        { status: "unknown" },
        { instanceId: ProviderInstanceId.make("codex_proxy"), status: "ready" },
      ),
      provider("cursor", SIGNED_OUT, { enabled: false }),
      provider("opencode", SIGNED_OUT, { installed: false }),
      provider("grok", SIGNED_OUT, {
        availability: "unavailable",
        unavailableReason: "No driver.",
      }),
    ]);
    expect(rows.map((row) => [row.displayName, row.status, row.detail, row.canSignIn])).toEqual([
      // The email stays off the list.
      ["Codex", "Signed in", "ChatGPT Pro", false],
      // A Codex on a custom model provider works without a sign-in.
      ["Codex Proxy", "Ready", undefined, false],
      ["Cursor", "Disabled", undefined, false],
      ["OpenCode", "Not installed", undefined, false],
      ["Grok", "Unavailable", "No driver.", false],
    ]);
  });

  it("leaves an instance disabled in its settings alone before the node re-probes", () => {
    const [codex] = rowsOf([provider("codex", SIGNED_OUT)], {
      codex: { driver: ProviderDriverKind.make("codex"), enabled: false },
    });
    expect(codex).toMatchObject({ status: "Disabled", canSignIn: false, instanceEnabled: false });
  });

  it("never offers a sign-in for a Claude instance on a CLIProxyAPI hub", () => {
    const hub: ProviderInstanceConfig = {
      driver: ProviderDriverKind.make("claudeAgent"),
      // What a client gets for a sensitive variable: the name, and no value.
      environment: ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"].map((name) => ({
        name,
        value: "",
        sensitive: true,
        valueRedacted: true,
      })),
    };
    const [proxied] = rowsOf([provider("claudeAgent", { status: "authenticated" })], {
      claudeAgent: hub,
    });
    expect(proxied).toMatchObject({ status: "Own credentials", canSignIn: false });
    // Without such settings, Claude without an account is not signed in.
    const [local] = rowsOf([provider("claudeAgent", { status: "authenticated" })]);
    expect(local).toMatchObject({
      status: "Not signed in",
      canSignIn: PROVIDER_SIGN_IN_DRIVERS.has("claudeAgent"),
    });
  });

  it("points drivers that do not sign in from Ryco yet to their own CLI", () => {
    const [opencode] = rowsOf([provider("opencode", SIGNED_OUT)]);
    expect(opencode).toMatchObject({
      status: "Not signed in",
      detail: PROVIDER_SIGN_IN_DRIVERS.has("opencode")
        ? "Tap to sign in."
        : "Sign in with its own CLI on Studio.",
    });
    const [cursor] = rowsOf([provider("cursor", { status: "unknown" })]);
    expect(cursor.status).toBe("Sign-in unknown");
  });

  it("says a Claude whose check failed is unknown, with the node's reason, not signed out", () => {
    const unverified = "Could not verify Claude authentication status from initialization result.";
    const failed = "Claude Agent CLI is installed but failed to run.";
    const rows = rowsOf([
      provider("claudeAgent", { status: "unknown" }, { status: "warning", message: unverified }),
      provider(
        "claudeAgent",
        { status: "unknown" },
        { instanceId: ProviderInstanceId.make("claude_work"), status: "error", message: failed },
      ),
    ]);
    const signsIn = PROVIDER_SIGN_IN_DRIVERS.has("claudeAgent");
    expect(rows.map((row) => [row.status, row.detail, row.canSignIn])).toEqual([
      ["Sign-in unknown", signsIn ? "Tap to sign in." : unverified, signsIn],
      ["Sign-in unknown", signsIn ? "Tap to sign in." : failed, signsIn],
    ]);
  });
});

describe("lastHttpsUrl", () => {
  it("finds the last page a terminal sign-in asks to open", () => {
    expect(
      lastHttpsUrl(
        "Visit https://example.com/first\nthen open https://claude.ai/oauth/authorize?code=true&state=x.\n",
      ),
    ).toBe("https://claude.ai/oauth/authorize?code=true&state=x");
    expect(lastHttpsUrl("(see https://example.com/help)")).toBe("https://example.com/help");
    expect(lastHttpsUrl("http://insecure.example.com only")).toBeNull();
    expect(lastHttpsUrl("")).toBeNull();
  });
});
