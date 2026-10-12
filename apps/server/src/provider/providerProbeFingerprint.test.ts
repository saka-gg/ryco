import { chmodSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@ryco/contracts";
import { Effect } from "effect";

import { computeProviderProbeFingerprint } from "./providerProbeFingerprint.ts";

const makeBinDir = () => {
  const binDir = path.join(os.tmpdir(), `ryco-probe-fingerprint-${crypto.randomUUID()}`);
  mkdirSync(binDir, { recursive: true });
  const binary = path.join(binDir, "tool");
  writeFileSync(binary, "#!/bin/sh\n");
  chmodSync(binary, 0o755);
  return { binDir, binary };
};

describe("computeProviderProbeFingerprint", () => {
  it.effect("is stable for unchanged inputs and changes with the binary, settings or auth", () =>
    Effect.gen(function* () {
      const { binDir, binary } = makeBinDir();
      const authFile = path.join(binDir, "auth.json");
      writeFileSync(authFile, "{}");
      const input = {
        driverKind: ProviderDriverKind.make("codex"),
        binaryPaths: ["tool"],
        env: { PATH: binDir },
        settings: { config: { binaryPath: "tool", homePath: "" } },
        authFiles: [authFile],
      };

      const first = yield* computeProviderProbeFingerprint(input);
      expect(yield* computeProviderProbeFingerprint(input)).toBe(first);

      const changedSettings = yield* computeProviderProbeFingerprint({
        ...input,
        settings: { config: { binaryPath: "tool", homePath: "/elsewhere" } },
      });
      expect(changedSettings).not.toBe(first);

      // An upgrade replaces or rewrites the binary.
      utimesSync(binary, new Date(1_000_000), new Date(1_000_000));
      const upgraded = yield* computeProviderProbeFingerprint(input);
      expect(upgraded).not.toBe(first);

      // Logging in or out rewrites the credential file.
      writeFileSync(authFile, '{"token":"new"}');
      expect(yield* computeProviderProbeFingerprint(input)).not.toBe(upgraded);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("distinguishes a missing binary from an installed one", () =>
    Effect.gen(function* () {
      const { binDir } = makeBinDir();
      const missing = {
        driverKind: ProviderDriverKind.make("codex"),
        binaryPaths: ["not-installed-tool"],
        env: { PATH: binDir },
        settings: {},
      };
      const missingFingerprint = yield* computeProviderProbeFingerprint(missing);
      expect(yield* computeProviderProbeFingerprint(missing)).toBe(missingFingerprint);
      expect(
        yield* computeProviderProbeFingerprint({ ...missing, binaryPaths: ["tool"] }),
      ).not.toBe(missingFingerprint);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
