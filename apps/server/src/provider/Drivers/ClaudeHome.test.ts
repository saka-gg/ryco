import { mkdirSync, writeFileSync } from "node:fs";
import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@ryco/contracts";
import { Effect, Path } from "effect";

import { computeProviderProbeFingerprint } from "../providerProbeFingerprint.ts";

import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeHomePath,
  resolveClaudeProbeAuthFiles,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("uses the process home when no Claude home override is configured", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* resolveClaudeHomePath({ homePath: "" })).toBe(resolved);
        expect(yield* makeClaudeEnvironment({ homePath: "" })).toBe(process.env);
      }),
    );

    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).HOME).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}`,
        );
      }),
    );

    it.effect("keeps continuation compatible across instances with the same Claude HOME", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" })).toBe(
          `claude:home:${resolved}`,
        );
      }),
    );

    it.effect("re-fingerprints the probe when Claude settings.json switches auth", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const configDir = path.join(NodeOS.tmpdir(), `ryco-claude-home-${crypto.randomUUID()}`);
        mkdirSync(configDir, { recursive: true });
        const env = { CLAUDE_CONFIG_DIR: configDir, PATH: "" };

        const authFiles = yield* resolveClaudeProbeAuthFiles({ homePath: "" }, env);
        expect(authFiles).toEqual([
          path.join(configDir, ".credentials.json"),
          path.join(configDir, "settings.json"),
        ]);

        const fingerprint = computeProviderProbeFingerprint({
          driverKind: ProviderDriverKind.make("claudeAgent"),
          binaryPaths: [],
          env,
          settings: {},
          authFiles,
        });
        const before = yield* fingerprint;
        writeFileSync(path.join(configDir, "settings.json"), '{"apiKeyHelper":"/bin/key"}');
        expect(yield* fingerprint).not.toBe(before);
      }),
    );
  });
});
