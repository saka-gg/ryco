import { Effect, Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import { rejectExcessProperties } from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";
import {
  EffectiveProjectPreferences,
  InitialModelSelection,
  PROJECT_PREFERENCE_ADDED_KEYS,
  PROJECT_PREFERENCE_KEYS,
  PROJECT_PREFERENCE_VALUE_KEYS,
  PROJECT_PREFERENCE_VALUES,
  PreferenceSource,
  ProjectPreferences,
  ProjectPreferencesExpected,
  ProjectPreferencesPatch,
  ServerSettings,
  ServerSettingsPatch,
  ThreadEnvMode,
  WorktreeBranchPrefix,
  WorktreeRoot,
  type ProjectPreferenceKey,
  type ProjectPreferenceValueKey,
} from "./settings.ts";

/**
 * Every key a project may override, reviewed one by one: each is a preference for what a new
 * thread starts with, never execution authority. Adding a key to the registry fails this file
 * until it is added here too, so the review cannot be skipped. Never add runtime or interaction
 * mode, approval policy, provider configuration, scripts, environment variables or paths.
 */
const REVIEWED_PROJECT_PREFERENCE_KEYS = [
  "initialModelSelection",
  "defaultThreadEnvMode",
  "worktreeBranchPrefix",
  "runSetupScript",
  // Both only shape generated text: branch names and pull request descriptions.
  "worktreeBranchChangeTypes",
  "pullRequestTemplates",
] as const;

/** Added after nodes first reported effective preferences: an older node's reply omits them. */
const ADDED_PROJECT_PREFERENCE_KEYS = [
  "worktreeBranchChangeTypes",
  "pullRequestTemplates",
] as const;

/** Node settings that grant authority or name a path; none may become a project override. */
const NEVER_PROJECT_PREFERENCES = [
  "agentControl",
  "providers",
  "providerInstances",
  "lowerAgentProcessPriority",
  "continueThreadsAfterRestart",
  "automaticUpdates",
  "worktreeRoot",
  "projectWorktreeRoots",
  "addProjectBaseDirectory",
  "textGenerationModelSelection",
  "cliProxyHubs",
] as const;

// The hand-written schemas this registry replaced, copied as they were. The derived schemas must
// decode and encode every payload exactly as these did. A key added to the registry later
// changes the derived schemas on purpose: add it to these copies, as an optional key.
const LegacyProjectPreferences = Schema.Struct({
  initialModelSelection: Schema.optionalKey(Schema.NullOr(InitialModelSelection)),
  defaultThreadEnvMode: Schema.optionalKey(ThreadEnvMode),
  worktreeBranchPrefix: Schema.optionalKey(WorktreeBranchPrefix),
  runSetupScript: Schema.optionalKey(Schema.Boolean),
  worktreeBranchChangeTypes: Schema.optionalKey(Schema.Boolean),
  pullRequestTemplates: Schema.optionalKey(Schema.Boolean),
});
const LegacyProjectPreferencesPatch = Schema.Struct({
  initialModelSelection: Schema.optionalKey(Schema.NullOr(InitialModelSelection)),
  defaultThreadEnvMode: Schema.optionalKey(Schema.NullOr(ThreadEnvMode)),
  worktreeBranchPrefix: Schema.optionalKey(Schema.NullOr(WorktreeBranchPrefix)),
  runSetupScript: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  worktreeBranchChangeTypes: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  pullRequestTemplates: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
}).pipe(rejectExcessProperties);
const LegacyProjectPreferencesExpected = Schema.Struct({
  ...LegacyProjectPreferencesPatch.fields,
  initialModelSelection: Schema.optionalKey(
    Schema.Union([Schema.Literal("absent"), Schema.NullOr(InitialModelSelection)]),
  ),
});
const legacySourced = <S extends Schema.Top>(value: S) =>
  Schema.Struct({ value, source: PreferenceSource });
const LegacyEffectiveProjectPreferences = Schema.Struct({
  initialModelSelection: legacySourced(ModelSelection),
  defaultThreadEnvMode: legacySourced(ThreadEnvMode),
  worktreeBranchPrefix: legacySourced(WorktreeBranchPrefix),
  runSetupScript: legacySourced(Schema.Boolean),
  worktreeBranchChangeTypes: Schema.optionalKey(legacySourced(Schema.Boolean)),
  pullRequestTemplates: Schema.optionalKey(legacySourced(Schema.Boolean)),
  worktreeRoot: legacySourced(WorktreeRoot),
  overrides: LegacyProjectPreferences.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});

const MODEL =
  '{"instanceId":"codex","model":"fixture-model","options":[{"id":"reasoningEffort","value":"high"}]}';

/** Payloads as nodes persist and send them today: each must survive a round trip byte for byte. */
const GOLDEN = {
  stored: [
    "{}",
    '{"initialModelSelection":null}',
    `{"initialModelSelection":${MODEL},"defaultThreadEnvMode":"worktree","worktreeBranchPrefix":"team/tasks","runSetupScript":false}`,
    '{"worktreeBranchPrefix":""}',
    '{"defaultThreadEnvMode":"local","runSetupScript":true}',
  ],
  patch: [
    "{}",
    '{"initialModelSelection":null,"defaultThreadEnvMode":null,"worktreeBranchPrefix":null,"runSetupScript":null}',
    `{"initialModelSelection":${MODEL},"worktreeBranchPrefix":""}`,
    '{"runSetupScript":false}',
  ],
  expected: [
    '{"initialModelSelection":"absent"}',
    '{"initialModelSelection":null,"defaultThreadEnvMode":"worktree"}',
    `{"initialModelSelection":${MODEL},"worktreeBranchPrefix":null,"runSetupScript":false}`,
  ],
  effective: [
    `{"initialModelSelection":{"value":${MODEL},"source":"project"},"defaultThreadEnvMode":{"value":"worktree","source":"project"},"worktreeBranchPrefix":{"value":"ryco","source":"node"},"runSetupScript":{"value":true,"source":"node"},"worktreeRoot":{"value":"/checkouts","source":"project"},"overrides":{"initialModelSelection":${MODEL},"defaultThreadEnvMode":"worktree"}}`,
    '{"initialModelSelection":{"value":{"instanceId":"codex","model":"gpt-5.4"},"source":"legacy-project"},"defaultThreadEnvMode":{"value":"local","source":"node"},"worktreeBranchPrefix":{"value":"","source":"project"},"runSetupScript":{"value":false,"source":"project"},"worktreeRoot":{"value":"","source":"builtin"},"overrides":{"worktreeBranchPrefix":"","runSetupScript":false}}',
  ],
  serverSettingsPatch: [
    '{"projectPreferences":{"p":{"runSetupScript":false}},"expectedProjectPreferences":{"p":{"runSetupScript":null}}}',
    '{"projectPreferences":{"p":{"initialModelSelection":null,"defaultThreadEnvMode":null}},"expectedProjectPreferences":{"p":{"initialModelSelection":"absent","defaultThreadEnvMode":"worktree"}}}',
    '{"projectPreferences":{"p":null,"q":{"worktreeBranchPrefix":"team"}}}',
    '{"expectedNodePreferences":{"defaultThreadEnvMode":"local"},"defaultThreadEnvMode":"worktree"}',
    `{"initialModelSelection":${MODEL},"expectedNodePreferences":{"initialModelSelection":null}}`,
  ],
} as const;

/** Payloads both generations must treat alike: rejected, or decoded to the same value. */
const CORPUS = {
  stored: [
    ...GOLDEN.stored,
    '{"runSetupScript":false,"runtimeMode":"full-access"}',
    '{"worktreeBranchPrefix":" team/tasks "}',
    '{"initialModelSelection":{"provider":"codex","model":"gpt-5.4"}}',
    '{"defaultThreadEnvMode":"cloud"}',
    '{"defaultThreadEnvMode":null}',
    '{"worktreeBranchPrefix":"team/"}',
    '{"runSetupScript":"yes"}',
    '{"initialModelSelection":"absent"}',
  ],
  patch: [
    ...GOLDEN.patch,
    '{"runtimeMode":"full-access"}',
    '{"runSetupScript":false,"scripts":[]}',
    '{"initialModelSelection":"absent"}',
    '{"defaultThreadEnvMode":"cloud"}',
    '{"worktreeBranchPrefix":"a..b"}',
    `{"initialModelSelection":{"instanceId":"codex","model":"m","options":[{"id":"permissionMode","value":"bypass"}]}}`,
  ],
  expected: [
    ...GOLDEN.expected,
    '{"defaultThreadEnvMode":"absent"}',
    '{"runSetupScript":"absent"}',
    '{"runtimeMode":"full-access"}',
  ],
  effective: [
    ...GOLDEN.effective,
    // An older node's reply without overrides.
    '{"initialModelSelection":{"value":{"instanceId":"codex","model":"m"},"source":"builtin"},"defaultThreadEnvMode":{"value":"local","source":"node"},"worktreeBranchPrefix":{"value":"ryco","source":"node"},"runSetupScript":{"value":true,"source":"node"},"worktreeRoot":{"value":"","source":"builtin"}}',
    '{"initialModelSelection":{"value":{"instanceId":"codex","model":"m"},"source":"builtin"},"defaultThreadEnvMode":{"value":"local","source":"inherited"},"worktreeBranchPrefix":{"value":"ryco","source":"node"},"runSetupScript":{"value":true,"source":"node"},"worktreeRoot":{"value":"","source":"builtin"}}',
    '{"initialModelSelection":{"value":{"instanceId":"codex","model":"m"},"source":"builtin"},"worktreeBranchPrefix":{"value":"ryco","source":"node"},"runSetupScript":{"value":true,"source":"node"},"worktreeRoot":{"value":"","source":"builtin"}}',
  ],
} as const;

const PAIRS = {
  stored: [ProjectPreferences, LegacyProjectPreferences],
  patch: [ProjectPreferencesPatch, LegacyProjectPreferencesPatch],
  expected: [ProjectPreferencesExpected, LegacyProjectPreferencesExpected],
  effective: [EffectiveProjectPreferences, LegacyEffectiveProjectPreferences],
} as const satisfies Record<keyof typeof CORPUS, readonly [Schema.Top, Schema.Top]>;

/** The encoded JSON of a decoded payload, or the failure, so two schemas compare exactly. */
function roundTrip(schema: Schema.Top, json: string): string {
  const codec = schema as unknown as Schema.Codec<unknown, unknown>;
  try {
    const decoded = Schema.decodeUnknownSync(codec)(JSON.parse(json));
    return JSON.stringify(Schema.encodeUnknownSync(codec)(decoded));
  } catch {
    return "<rejected>";
  }
}

describe("project preference registry", () => {
  it("lists the initial model first, then each node setting a project may override", () => {
    expect(PROJECT_PREFERENCE_KEYS).toEqual([
      "initialModelSelection",
      ...PROJECT_PREFERENCE_VALUE_KEYS,
    ]);
    expectTypeOf<ProjectPreferenceKey>().toEqualTypeOf<
      (typeof REVIEWED_PROJECT_PREFERENCE_KEYS)[number]
    >();
  });

  it("requires every key in a node's effective reply, so a reply missing one is rejected", () => {
    const decode = Schema.decodeUnknownExit(EffectiveProjectPreferences);
    const reply = JSON.parse(CORPUS.effective[2]);
    expect(decode(reply)._tag).toBe("Success");
    for (const key of PROJECT_PREFERENCE_KEYS) {
      const { [key]: _omitted, ...older } = reply;
      expect(decode(older)._tag, key).toBe(
        (ADDED_PROJECT_PREFERENCE_KEYS as ReadonlyArray<string>).includes(key)
          ? "Success"
          : "Failure",
      );
    }
  });

  it("names the keys added since for clients", () => {
    expect([...PROJECT_PREFERENCE_ADDED_KEYS]).toEqual([...ADDED_PROJECT_PREFERENCE_KEYS]);
  });

  it("accepts a reply that has the keys added since, and one without them", () => {
    const decode = Schema.decodeUnknownExit(EffectiveProjectPreferences);
    const older = JSON.parse(CORPUS.effective[2]);
    for (const key of ADDED_PROJECT_PREFERENCE_KEYS) expect(older).not.toHaveProperty(key);
    const newer = {
      ...older,
      worktreeBranchChangeTypes: { value: false, source: "project" },
      pullRequestTemplates: { value: true, source: "node" },
    };
    expect(decode(newer)).toMatchObject({ _tag: "Success", value: newer });
  });

  it("holds only reviewed creation preferences, never execution authority", () => {
    expect([...PROJECT_PREFERENCE_KEYS].toSorted()).toEqual(
      [...REVIEWED_PROJECT_PREFERENCE_KEYS].toSorted(),
    );
    for (const key of NEVER_PROJECT_PREFERENCES) {
      expect(Object.keys(ServerSettings.fields)).toContain(key);
      expect(PROJECT_PREFERENCE_KEYS).not.toContain(key);
    }
    for (const key of PROJECT_PREFERENCE_KEYS)
      expect(key).not.toMatch(/runtime|interaction|approval|permission|provider|path|root/i);
  });

  it("derives every schema's fields from the registry", () => {
    expect(Object.keys(ProjectPreferences.fields)).toEqual(PROJECT_PREFERENCE_KEYS);
    expect(Object.keys(ProjectPreferencesPatch.fields)).toEqual(PROJECT_PREFERENCE_KEYS);
    expect(Object.keys(ProjectPreferencesExpected.fields)).toEqual(PROJECT_PREFERENCE_KEYS);
    expect(Object.keys(EffectiveProjectPreferences.fields)).toEqual([
      ...PROJECT_PREFERENCE_KEYS,
      "worktreeRoot",
      "overrides",
    ]);
    expectTypeOf<keyof ProjectPreferences>().toEqualTypeOf<ProjectPreferenceKey>();
    expectTypeOf<keyof ProjectPreferencesPatch>().toEqualTypeOf<ProjectPreferenceKey>();
    expectTypeOf<keyof ProjectPreferencesExpected>().toEqualTypeOf<ProjectPreferenceKey>();
    expectTypeOf<
      Exclude<keyof EffectiveProjectPreferences, "worktreeRoot" | "overrides">
    >().toEqualTypeOf<ProjectPreferenceKey>();
  });

  it("types each override as the node setting of the same name", () => {
    expectTypeOf<{
      readonly [K in ProjectPreferenceValueKey]: (typeof PROJECT_PREFERENCE_VALUES.Type)[K];
    }>().toEqualTypeOf<Pick<ServerSettings, ProjectPreferenceValueKey>>();
    expectTypeOf<{
      // Keys added since are optional in the reply; present, they carry the node setting's type.
      readonly [K in ProjectPreferenceValueKey]: NonNullable<
        EffectiveProjectPreferences[K]
      >["value"];
    }>().toEqualTypeOf<Pick<ServerSettings, ProjectPreferenceValueKey>>();
  });

  it("accepts a registry key in a patch and still rejects unknown keys", () => {
    const decodePatch = Schema.decodeUnknownExit(ProjectPreferencesPatch);
    for (const key of PROJECT_PREFERENCE_KEYS)
      expect(decodePatch({ [key]: null })._tag, key).toBe("Success");
    expect(decodePatch({ runtimeMode: "full-access" })._tag).toBe("Failure");
    expect(decodePatch({ runSetupScript: true, interactionMode: "plan" })._tag).toBe("Failure");
    const decodeServerPatch = Schema.decodeUnknownExit(ServerSettingsPatch);
    expect(decodeServerPatch({ projectPreferences: { p: { runSetupScript: true } } })._tag).toBe(
      "Success",
    );
    expect(
      decodeServerPatch({ projectPreferences: { p: { runtimeMode: "full-access" } } })._tag,
    ).toBe("Failure");
    expect(decodeServerPatch({ expectedNodePreferences: { worktreeRoot: "/" } })._tag).toBe(
      "Failure",
    );
  });

  it.each(
    PROJECT_PREFERENCE_VALUE_KEYS.flatMap((key) =>
      [
        "local",
        "worktree",
        "cloud",
        "",
        "ryco",
        " team/tasks ",
        "team/",
        "a..b",
        "a".repeat(129),
        true,
        false,
        "true",
        0,
        null,
      ].map((value) => [key, value] as const),
    ),
  )("decodes %s = %j exactly as the node setting does", (key, value) => {
    const asNode = Schema.decodeUnknownExit(ServerSettings)({ [key]: value });
    const asProject = Schema.decodeUnknownExit(ProjectPreferences)({ [key]: value });
    expect(asProject._tag).toBe(asNode._tag);
    if (asNode._tag === "Success" && asProject._tag === "Success")
      expect(asProject.value[key]).toEqual(asNode.value[key]);
  });
});

describe("project preference wire compatibility", () => {
  it.each(
    Object.entries(GOLDEN).flatMap(([kind, payloads]) =>
      payloads.map((payload) => [kind as keyof typeof GOLDEN, payload] as const),
    ),
  )("round-trips a %s payload byte for byte", (kind, payload) => {
    const schema = kind === "serverSettingsPatch" ? ServerSettingsPatch : PAIRS[kind][0];
    expect(roundTrip(schema, payload)).toBe(payload);
  });

  it.each(
    Object.entries(CORPUS).flatMap(([kind, payloads]) =>
      payloads.map((payload) => [kind as keyof typeof CORPUS, payload] as const),
    ),
  )(
    "decodes and encodes a %s payload exactly as the hand-written schema did: %s",
    (kind, payload) => {
      const [derived, legacy] = PAIRS[kind];
      expect(roundTrip(derived, payload)).toBe(roundTrip(legacy, payload));
    },
  );

  it("keeps the same JSON Schema as the hand-written schemas", () => {
    for (const [derived, legacy] of Object.values(PAIRS))
      expect(Schema.toJsonSchemaDocument(derived)).toEqual(Schema.toJsonSchemaDocument(legacy));
  });

  it("round-trips a persisted settings file's project preferences", () => {
    const stored = {
      p: JSON.parse(GOLDEN.stored[2]),
      q: { worktreeBranchPrefix: "" },
      r: { initialModelSelection: null },
    };
    const settings = Schema.decodeUnknownSync(ServerSettings)({ projectPreferences: stored });
    expect(settings.projectPreferences).toEqual(stored);
    expect(JSON.stringify(Schema.encodeSync(ServerSettings)(settings).projectPreferences)).toBe(
      JSON.stringify(stored),
    );
  });
});
