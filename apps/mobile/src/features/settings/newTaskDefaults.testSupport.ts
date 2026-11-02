/**
 * A fake node for the "New tasks" panel's tests: its settings, the effective preferences it
 * answers with, and writes it checks the way a node does (compare-and-set included), so a stale
 * write is refused exactly as a real node refuses it. Test-only; no app module imports it.
 *
 * @module newTaskDefaults.testSupport
 */
import type {
  EffectiveProjectPreferences,
  EnvironmentApi,
  ModelCapabilities,
  ServerConfig,
  ServerSettings,
  ServerSettingsPatch,
} from "@ryco/contracts";
import { ProviderInstanceId } from "@ryco/contracts/provider-instance";
import { DEFAULT_SERVER_SETTINGS } from "@ryco/contracts/settings";
import { applyServerSettingsPatch } from "@ryco/shared/serverSettings";

export const TEST_PROVIDER = ProviderInstanceId.make("codex");
export const TEST_BUILTIN_MODEL = { instanceId: TEST_PROVIDER, model: "gpt-builtin" };

const CAPABILITIES = {
  optionDescriptors: [
    // A trait a creation preset may not carry: never on the rail, never saved.
    {
      id: "agent",
      label: "Agent",
      type: "select",
      options: [{ id: "build", label: "Build", isDefault: true }],
    },
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "low", label: "Low" },
        { id: "high", label: "High", isDefault: true },
      ],
    },
  ],
} as unknown as ModelCapabilities;

/** A node's config with two models; capabilities default to a current node. */
export function testNodeConfig(
  settings: ServerSettings = DEFAULT_SERVER_SETTINGS,
  capabilities: Record<string, boolean> = {
    projectPreferences: true,
    worktreeSubmoduleSettings: true,
  },
): ServerConfig {
  return {
    environment: { label: "node", capabilities },
    settings,
    providers: [
      {
        instanceId: TEST_PROVIDER,
        driver: "codex",
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        models: [
          { slug: "gpt-builtin", name: "GPT Builtin", isCustom: false, capabilities: CAPABILITIES },
          { slug: "gpt-fast", name: "GPT Fast", isCustom: false, capabilities: CAPABILITIES },
        ],
      },
    ],
  } as unknown as ServerConfig;
}

type ValueKey =
  | "defaultThreadEnvMode"
  | "worktreeBranchPrefix"
  | "runSetupScript"
  | "worktreeBranchChangeTypes"
  | "pullRequestTemplates";

/** Effective preferences as a node resolves them from its settings, for a project or itself. */
export function testEffectivePreferences(
  settings: ServerSettings,
  projectId?: string,
): EffectiveProjectPreferences {
  const overrides = projectId ? (settings.projectPreferences[projectId] ?? {}) : {};
  const sourced = (key: ValueKey) => ({
    value: overrides[key] ?? settings[key],
    source: overrides[key] === undefined ? ("node" as const) : ("project" as const),
  });
  return {
    overrides,
    initialModelSelection: overrides.initialModelSelection
      ? { value: overrides.initialModelSelection, source: "project" }
      : settings.initialModelSelection
        ? { value: settings.initialModelSelection, source: "node" }
        : { value: TEST_BUILTIN_MODEL, source: "builtin" },
    defaultThreadEnvMode: sourced("defaultThreadEnvMode"),
    worktreeBranchPrefix: sourced("worktreeBranchPrefix"),
    runSetupScript: sourced("runSetupScript"),
    worktreeBranchChangeTypes: sourced("worktreeBranchChangeTypes"),
    pullRequestTemplates: sourced("pullRequestTemplates"),
    worktreeRoot: { value: "", source: "builtin" },
  } as EffectiveProjectPreferences;
}

type Read = (projectId: string | undefined) => Promise<EffectiveProjectPreferences>;

export interface TestNode {
  readonly api: EnvironmentApi;
  /** The project each read asked for (undefined: the node's own defaults). */
  readonly reads: ReadonlyArray<string | undefined>;
  readonly writes: ReadonlyArray<ServerSettingsPatch>;
  readonly settings: ServerSettings;
  /** Another device changes this node. */
  readonly changeElsewhere: (patch: ServerSettingsPatch) => void;
  /** The node's own write: applies the patch, or refuses it as the node would. */
  readonly write: (patch: ServerSettingsPatch) => Promise<void>;
  /** Answers the next read this way instead (late, failing, …). */
  readonly answerNextRead: (read: Read) => void;
}

export function testNode(initial: ServerSettings = DEFAULT_SERVER_SETTINGS): TestNode {
  let settings = initial;
  const reads: Array<string | undefined> = [];
  const writes: ServerSettingsPatch[] = [];
  const nextReads: Read[] = [];
  const api = {
    server: {
      getProjectPreferences: async (input: { readonly projectId?: string }) => {
        reads.push(input.projectId);
        const read = nextReads.shift();
        return read ? read(input.projectId) : testEffectivePreferences(settings, input.projectId);
      },
    },
  } as unknown as EnvironmentApi;
  return {
    api,
    reads,
    writes,
    get settings() {
      return settings;
    },
    changeElsewhere: (patch) => {
      settings = applyServerSettingsPatch(settings, patch);
    },
    write: async (patch) => {
      writes.push(patch);
      settings = applyServerSettingsPatch(settings, patch);
    },
    answerNextRead: (read) => {
      nextReads.push(read);
    },
  };
}

/** Lets every pending read and write settle: they wait on each other, never on a clock. */
export async function settleNewTaskDefaults(): Promise<void> {
  for (let round = 0; round < 20; round += 1) await Promise.resolve();
}
