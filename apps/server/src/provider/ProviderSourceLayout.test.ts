import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { NodeServices } from "@effect/platform-node";
import { CodexSettings, ProviderDriverKind } from "@ryco/contracts";
import { resolveProviderSourceLayout } from "./ProviderSourceLayout.ts";
import { resolveCodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";
import { normalizeProviderHomeEnvironment } from "./ProviderInstanceEnvironment.ts";
import {
  makeClaudeEnvironment,
  resolveClaudeHomePath,
  resolveClaudeSourceRoot,
  makeClaudeContinuationGroupKey,
} from "./Drivers/ClaudeHome.ts";

it.layer(NodeServices.layer)("provider source layouts", (it) => {
  it.effect(
    "shares Codex config-over-environment precedence and authoritative auth-overlay history",
    () =>
      Effect.gen(function* () {
        const config = Schema.decodeSync(CodexSettings)({
          homePath: "/synthetic/shared",
          shadowHomePath: "/synthetic/shadow",
        });
        const layout = yield* resolveCodexHomeLayout(config, {
          CODEX_HOME: "/synthetic/env",
          HOME: "/synthetic/home",
        });
        expect(layout.sharedHomePath).toBe("/synthetic/shared");
        expect(layout.effectiveHomePath).toBe("/synthetic/shadow");
        const imported = yield* resolveProviderSourceLayout("codex", {
          driver: ProviderDriverKind.make("codex"),
          config,
          environment: [{ name: "CODEX_HOME", value: "/synthetic/env", sensitive: false }],
        });
        expect(imported.codex).toEqual(layout);
        expect(
          (yield* resolveCodexHomeLayout(Schema.decodeSync(CodexSettings)({}), {
            CODEX_HOME: "/synthetic/env",
          })).sharedHomePath,
        ).toBe("/synthetic/env");
        expect(
          (yield* resolveCodexHomeLayout(Schema.decodeSync(CodexSettings)({}), {
            HOME: "/synthetic/home",
          })).sharedHomePath,
        ).toBe("/synthetic/home/.codex");
      }),
  );
  it.effect("preserves default Codex home bootstrap without forcing an absent CODEX_HOME", () =>
    Effect.gen(function* () {
      const config = Schema.decodeSync(CodexSettings)({});
      expect(
        (yield* resolveCodexHomeLayout(config, { HOME: "/synthetic/new-home" })).effectiveHomePath,
      ).toBeUndefined();
      expect(
        (yield* resolveCodexHomeLayout(config, { CODEX_HOME: "/synthetic/explicit" }))
          .effectiveHomePath,
      ).toBe("/synthetic/explicit");
    }),
  );
  it.effect("normalizes Codex HOME before the provider enters a project cwd", () =>
    Effect.gen(function* () {
      const environment = normalizeProviderHomeEnvironment({ HOME: "synthetic-home" });
      const layout = yield* resolveCodexHomeLayout(
        Schema.decodeSync(CodexSettings)({}),
        environment,
      );
      expect(environment.HOME).toMatch(/^\//);
      expect(layout.sharedHomePath).toBe(`${environment.HOME}/.codex`);
      expect(layout.effectiveHomePath).toBeUndefined();
    }),
  );
  it.effect(
    "normalizes Claude environment homes for both native runtime and source discovery",
    () =>
      Effect.gen(function* () {
        const config = { homePath: "" };
        const environment = yield* makeClaudeEnvironment(config, {
          HOME: "synthetic-home",
          CLAUDE_CONFIG_DIR: "synthetic-store",
        });
        expect(environment.HOME).toBe(
          yield* resolveClaudeHomePath(config, { HOME: "synthetic-home" }),
        );
        expect(environment.CLAUDE_CONFIG_DIR).toBe(
          yield* resolveClaudeSourceRoot(config, environment),
        );
        const blank = yield* makeClaudeEnvironment(config, {
          HOME: "/synthetic/home",
          CLAUDE_CONFIG_DIR: "   ",
        });
        expect(blank.CLAUDE_CONFIG_DIR).toBe("");
        expect(yield* resolveClaudeSourceRoot(config, blank)).toBe("/synthetic/home/.claude");
      }),
  );
  it.effect(
    "uses the exact Claude SDK configuration store under explicit HOME and config-directory overrides",
    () =>
      Effect.gen(function* () {
        const env = { HOME: "/synthetic/environment", CLAUDE_CONFIG_DIR: "/synthetic/config" };
        const config = { homePath: "/synthetic/instance" };
        expect((yield* makeClaudeEnvironment(config, env)).HOME).toBe("/synthetic/instance");
        expect(yield* resolveClaudeSourceRoot(config, env)).toBe("/synthetic/config");
        expect(yield* makeClaudeContinuationGroupKey(config, env)).toBe(
          "claude:store:/synthetic/config",
        );
        expect(yield* resolveClaudeSourceRoot(config, { HOME: "/synthetic/environment" })).toBe(
          "/synthetic/instance/.claude",
        );
        expect(
          yield* resolveClaudeSourceRoot({ homePath: "" }, { HOME: "/synthetic/environment" }),
        ).toBe("/synthetic/environment/.claude");
        expect(
          yield* makeClaudeContinuationGroupKey(
            { homePath: "" },
            { HOME: "/synthetic/environment" },
          ),
        ).toBe("claude:home:/synthetic/environment");
        const imported = yield* resolveProviderSourceLayout("claudeAgent", {
          driver: ProviderDriverKind.make("claudeAgent"),
          config,
          environment: [
            { name: "CLAUDE_CONFIG_DIR", value: "/synthetic/config", sensitive: false },
          ],
        });
        expect(imported.root).toBe("/synthetic/config");
        expect(imported.environment.HOME).toBe("/synthetic/instance");
      }),
  );
});
