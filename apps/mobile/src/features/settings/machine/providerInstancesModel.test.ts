import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type ServerConfig,
  type ServerProvider,
} from "@ryco/contracts";
import { getProviderDriverDefinition } from "@ryco/client-runtime/state/settings/providerDrivers";
import { deriveProviderSettingsFields } from "@ryco/client-runtime/state/settings/providerSettingsFields";
import { REDACTED_SETTING_SECRET } from "@ryco/shared/settingsSecrets";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderAccountsEnvironment } from "../providerAccountsModel";
import {
  acpAuthMethodRow,
  buildAddProviderInstance,
  buildProviderInstanceDetail,
  buildProviderInstancesList,
  configWithFieldText,
  environmentNeedsValueForPlain,
  environmentWithAdded,
  environmentWithSensitivity,
  environmentWithValue,
  instanceWithAddedModel,
  providerEnvironmentRows,
  providerFieldRow,
  providerInstanceEditPatch,
} from "./providerInstancesModel";

const STUDIO = EnvironmentId.make("studio");
const node: ProviderAccountsEnvironment = {
  environmentId: STUDIO,
  label: "Studio",
  connectionState: "connected",
  role: "owner",
  mutationReady: true,
};

function provider(driver: string, patch: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.2.3",
    status: "ready",
    auth: { status: "authenticated", label: "Pro" },
    checkedAt: "2026-11-09T10:00:00.000Z",
    models: [{ slug: "built-in", name: "Built in", isCustom: false, capabilities: null }],
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

const codex = ProviderDriverKind.make("codex");
const work = ProviderInstanceId.make("codex_work");

describe("buildProviderInstancesList", () => {
  it("waits for the machine's settings", () => {
    expect(buildProviderInstancesList({ node, config: null, connected: true }).rows).toBeNull();
  });

  it("lists built-in slots and added instances with their state", () => {
    const view = buildProviderInstancesList({
      node,
      config: config([provider("codex")], {
        [work]: { driver: codex, displayName: "Work", enabled: false },
      }),
      connected: true,
    });
    const codexRow = view.rows!.find((row) => row.instanceId === "codex")!;
    const workRow = view.rows!.find((row) => row.instanceId === work)!;
    expect(codexRow).toMatchObject({ label: "Codex", status: "Signed in", detail: undefined });
    expect(workRow).toMatchObject({ label: "Work", status: "Disabled", detail: "Added" });
    expect(view.rows!.find((row) => row.instanceId === "claudeAgent")!.status).toBe("Checking…");
    expect(view.takenIds.has("codex")).toBe(true);
    expect(view.takenIds.has(work)).toBe(true);
  });

  it("adds an instance under a free id, keeping the others as the server sent them", () => {
    const secret: ProviderInstanceConfig = {
      driver: codex,
      environment: [{ name: "KEY", value: "", sensitive: true, valueRedacted: true }],
    };
    const { settings } = config([], { [work]: secret });
    const { instanceId, patch } = buildAddProviderInstance({
      settings,
      takenIds: new Set([work]),
      driver: codex,
      label: "Work",
    });
    expect(instanceId).toBe("codex_work_2");
    expect(patch.providerInstances).toEqual({
      [work]: secret,
      [instanceId]: { driver: codex, enabled: true, displayName: "Work" },
    });
  });
});

describe("buildProviderInstanceDetail", () => {
  it("is null for an instance the machine does not have", () => {
    expect(
      buildProviderInstanceDetail({
        node,
        config: config([]),
        instanceId: ProviderInstanceId.make("gone"),
        connected: true,
      }),
    ).toBeNull();
  });

  it("reads a default slot's fields, models and account", () => {
    const detail = buildProviderInstanceDetail({
      node,
      config: config([provider("codex")]),
      instanceId: ProviderInstanceId.make("codex"),
      connected: true,
    })!;
    expect(detail).toMatchObject({
      displayName: "Codex",
      status: "Signed in",
      version: "1.2.3",
      builtInModelCount: 1,
      canRemove: false,
      canReset: false,
      acp: null,
    });
    expect(detail.fields.map((row) => row.field.key)).toEqual([
      "binaryPath",
      "homePath",
      "shadowHomePath",
    ]);
  });

  it("offers removal of an added instance and an ACP agent's source", () => {
    const acp = ProviderInstanceId.make("acpRegistry_gemini");
    const detail = buildProviderInstanceDetail({
      node,
      config: config([], {
        [acp]: {
          driver: ProviderDriverKind.make("acpRegistry"),
          config: { source: "local", command: "gemini", args: ["--acp"] },
        },
      }),
      instanceId: acp,
      connected: true,
    })!;
    expect(detail.canRemove).toBe(true);
    expect(detail.fields).toEqual([]);
    expect(detail.acp).toMatchObject({ source: "local", command: "gemini", args: ["--acp"] });
  });

  it("saves an edit of a default slot by promoting it, and resets text generation on disable", () => {
    const { settings } = config([]);
    const detail = buildProviderInstanceDetail({
      node,
      config: config([provider("codex")]),
      instanceId: ProviderInstanceId.make("codex"),
      connected: true,
    })!;
    const patch = providerInstanceEditPatch(settings, detail.row, {
      ...detail.row.instance,
      enabled: false,
    });
    expect(patch.providerInstances!["codex" as ProviderInstanceId]!.enabled).toBe(false);
    expect(patch.providers!.codex).toEqual(DEFAULT_SERVER_SETTINGS.providers.codex);
    expect(patch.textGenerationModelSelection).toEqual(
      settings.textGenerationModelSelection.instanceId === "codex"
        ? DEFAULT_SERVER_SETTINGS.textGenerationModelSelection
        : undefined,
    );
  });

  it("refuses a custom model the provider already has", () => {
    const detail = buildProviderInstanceDetail({
      node,
      config: config([provider("codex")]),
      instanceId: ProviderInstanceId.make("codex"),
      connected: true,
    })!;
    expect(instanceWithAddedModel(detail, "built-in")).toEqual({
      ok: false,
      error: "That model is already built in.",
    });
    const added = instanceWithAddedModel(detail, "mine");
    expect(added.ok && added.instance.config).toMatchObject({ customModels: ["mine"] });
  });
});

describe("driver fields", () => {
  const opencode = deriveProviderSettingsFields(getProviderDriverDefinition("opencode")!);
  const password = opencode.find((field) => field.key === "serverPassword")!;
  const url = opencode.find((field) => field.key === "serverUrl")!;

  it("shows only whether a secret is saved, and never prefills it", () => {
    const saved = providerFieldRow(password, { serverPassword: REDACTED_SETTING_SECRET });
    expect(saved).toMatchObject({ kind: "secret", value: "Set", saved: true, promptDefault: "" });
    expect(providerFieldRow(password, {})).toMatchObject({ value: "Not set", saved: false });
    // An empty answer keeps the saved secret; a new one replaces it.
    expect(configWithFieldText({ serverPassword: REDACTED_SETTING_SECRET }, saved, "")).toBeNull();
    expect(configWithFieldText({}, saved, "hunter2")).toEqual({ serverPassword: "hunter2" });
  });

  it("masks hidden URL credentials and does not prefill them", () => {
    const row = providerFieldRow(url, {
      serverUrl: `https://${REDACTED_SETTING_SECRET}@example.com`,
    });
    expect(row.value).toBe("https://•••@example.com");
    expect(row.promptDefault).toBe("");
    expect(row.note).toMatch(/hidden/);
  });
});

describe("environment variables", () => {
  const stored: ProviderInstanceEnvironmentVariable = {
    name: "API_KEY",
    value: "",
    sensitive: true,
    valueRedacted: true,
  };
  const plain: ProviderInstanceEnvironmentVariable = {
    name: "BASE_URL",
    value: "https://proxy",
    sensitive: false,
  };

  it("shows a secret as Set and a plain value as itself", () => {
    const rows = providerEnvironmentRows([stored, plain]);
    expect(rows).toEqual([
      { name: "API_KEY", sensitive: true, value: "Set", promptDefault: "" },
      {
        name: "BASE_URL",
        sensitive: false,
        value: "https://proxy",
        promptDefault: "https://proxy",
      },
    ]);
    expect(environmentNeedsValueForPlain(rows[0]!)).toBe(true);
  });

  it("adds a variable and refuses a bad or taken name", () => {
    expect(environmentWithAdded([plain], { name: "TOKEN", value: "x", sensitive: true })).toEqual({
      ok: true,
      environment: [plain, { name: "TOKEN", value: "x", sensitive: true }],
    });
    expect(environmentWithAdded([plain], { name: "1BAD", value: "x", sensitive: true }).ok).toBe(
      false,
    );
    expect(
      environmentWithAdded([plain], { name: "BASE_URL", value: "x", sensitive: false }),
    ).toEqual({ ok: false, error: "Another variable already uses this name." });
  });

  it("keeps a stored secret on an empty value and replaces it with a new one", () => {
    expect(environmentWithValue([stored], "API_KEY", "")).toEqual({
      ok: true,
      environment: [stored],
    });
    expect(environmentWithValue([stored], "API_KEY", "new")).toEqual({
      ok: true,
      environment: [{ name: "API_KEY", value: "new", sensitive: true }],
    });
  });

  it("only turns a stored secret into plain text with a new value", () => {
    expect(environmentWithSensitivity([stored], "API_KEY", false).ok).toBe(false);
    expect(environmentWithSensitivity([stored], "API_KEY", false, "visible")).toEqual({
      ok: true,
      environment: [{ name: "API_KEY", value: "visible", sensitive: false }],
    });
    expect(environmentWithSensitivity([plain], "BASE_URL", true)).toEqual({
      ok: true,
      environment: [{ ...plain, sensitive: true }],
    });
  });
});

describe("acpAuthMethodRow", () => {
  it("runs agent sign-ins from here and explains the others", () => {
    expect(acpAuthMethodRow({ id: "oauth", name: "Google", description: "Browser" })).toEqual({
      id: "oauth",
      label: "Google",
      detail: "Browser",
      runnable: true,
    });
    const env = acpAuthMethodRow({
      id: "key",
      name: "API key",
      type: "env_var",
      variables: [{ name: "GEMINI_API_KEY", optional: false, secret: true }],
    });
    expect(env.runnable).toBe(false);
    expect(env.detail).toBe(
      "Set GEMINI_API_KEY (sensitive) under Environment variables, then start a new chat.",
    );
    expect(acpAuthMethodRow({ id: "t", name: "Login", type: "terminal" }).runnable).toBe(false);
  });
});
