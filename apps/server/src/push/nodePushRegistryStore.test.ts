import * as NodeServices from "@effect/platform-node/NodeServices";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { makeNodePushRegistry, PUSH_FOREGROUND_HOLD_MS } from "./nodePushRegistryStore.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const run = <A>(effect: Effect.Effect<A, never, never>) => Effect.runPromise(effect);

async function store(now: { value: number }) {
  const directory = mkdtempSync(join(tmpdir(), "ryco-push-registry-"));
  directories.push(directory);
  const filePath = join(directory, "hub-push.json");
  const registry = await Effect.runPromise(
    makeNodePushRegistry({ filePath, now: () => now.value, newSalt: () => "s".repeat(43) }).pipe(
      Effect.provide(NodeServices.layer),
    ),
  );
  return { registry, filePath };
}

const device = { enrollmentId: "enr_device00000000000000000", role: "owner" as const };
const input = {
  keyId: "AAAAAAAAAAAAAAAAAAAAAA",
  publicKey: "x".repeat(43),
  kinds: ["completed" as const],
  sound: false,
};

describe("node push registry store", () => {
  it("persists registrations and sequences, and reports the Hub's last answer", async () => {
    const now = { value: 1_000 };
    const { registry, filePath } = await store(now);
    await run(registry.setHubDelivery("available"));
    const status = await run(registry.register(device, input));
    expect(status).toEqual({
      eligible: true,
      registered: true,
      keyId: input.keyId,
      kinds: ["completed"],
      hubDelivery: "available",
    });
    expect(await run(registry.reserveSequence)).toBe(1_000);
    expect(await run(registry.reserveSequence)).toBe(1_001);
    const stored = JSON.parse(readFileSync(filePath, "utf8"));
    expect(stored.nextSequence).toBe(1_002);
    expect(stored.registrations).toHaveLength(1);
    // A fresh process reads it back.
    const reopened = await Effect.runPromise(
      makeNodePushRegistry({ filePath, now: () => now.value }).pipe(
        Effect.provide(NodeServices.layer),
      ),
    );
    expect((await run(reopened.list)).map((entry) => entry.keyId)).toEqual([input.keyId]);
    expect(await run(reopened.reserveSequence)).toBe(1_002);
  });

  it("holds a foreground presence only while the device keeps saying so", async () => {
    const now = { value: 1_000 };
    const { registry } = await store(now);
    await run(registry.setPresence(device, "foreground"));
    expect(await run(registry.foregroundEnrollments(now.value))).toEqual(
      new Set([device.enrollmentId]),
    );
    expect(await run(registry.foregroundEnrollments(now.value + PUSH_FOREGROUND_HOLD_MS))).toEqual(
      new Set(),
    );
    await run(registry.setPresence(device, "foreground"));
    await run(registry.setPresence(device, "background"));
    expect(await run(registry.foregroundEnrollments(now.value))).toEqual(new Set());
  });

  it("forgets revoked enrollments and everything on clear, but keeps the sequence growing", async () => {
    const now = { value: 1_000 };
    const { registry } = await store(now);
    await run(registry.register(device, input));
    await run(registry.removeEnrollments([device.enrollmentId]));
    expect(await run(registry.list)).toEqual([]);
    await run(registry.register(device, input));
    const sequence = await run(registry.reserveSequence);
    await run(registry.clear);
    expect(await run(registry.list)).toEqual([]);
    expect(await run(registry.reserveSequence)).toBe(sequence + 1);
  });
});
