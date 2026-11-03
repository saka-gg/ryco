import { DEFAULT_SERVER_SETTINGS, EnvironmentId, type ServerConfig } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  CLIENT_INTERACTION_REPORT_INTERVAL_MS,
  createClientInteractionReporter,
  nodeWantsClientInteraction,
  type ClientInteractionConnection,
} from "./clientInteraction.ts";

const A = EnvironmentId.make("env-a");
const B = EnvironmentId.make("env-b");

function config(settings: Partial<ServerConfig["settings"]> | null): ServerConfig | null {
  return settings === null
    ? null
    : ({ settings: { ...DEFAULT_SERVER_SETTINGS, ...settings } } as unknown as ServerConfig);
}

function harness(configs: Map<EnvironmentId, ServerConfig | null>) {
  const sent: EnvironmentId[] = [];
  let nowMs = 1_000;
  let connections: ClientInteractionConnection[] = [A, B].map((environmentId) => ({
    environmentId,
    client: {
      server: {
        noteClientInteraction: async () => {
          sent.push(environmentId);
          return {};
        },
      },
    },
  }));
  const reporter = createClientInteractionReporter({
    listConnections: () => connections,
    readServerConfig: (environmentId) => configs.get(environmentId) ?? null,
    now: () => nowMs,
  });
  // Reports go out on a microtask, so a caller never waits on the network.
  const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));
  return {
    reporter,
    sent,
    flush,
    advance: (ms: number) => {
      nowMs += ms;
    },
    disconnect: (environmentId: EnvironmentId) => {
      connections = connections.filter((connection) => connection.environmentId !== environmentId);
    },
  };
}

describe("nodeWantsClientInteraction", () => {
  it("is on only with automatic updates and provider update checks", () => {
    expect(nodeWantsClientInteraction(config({ automaticUpdates: true }))).toBe(true);
    expect(nodeWantsClientInteraction(config({ automaticUpdates: false }))).toBe(false);
    expect(
      nodeWantsClientInteraction(
        config({ automaticUpdates: true, enableProviderUpdateChecks: false }),
      ),
    ).toBe(false);
    expect(nodeWantsClientInteraction(null)).toBe(false);
    // An older node's config has no such setting at all.
    expect(nodeWantsClientInteraction({ settings: {} } as unknown as ServerConfig)).toBe(false);
  });
});

describe("createClientInteractionReporter", () => {
  it("reports only to nodes that update themselves unattended", async () => {
    const test = harness(
      new Map([
        [A, config({ automaticUpdates: true })],
        [B, config({ automaticUpdates: false })],
      ]),
    );
    expect(test.reporter.wanted()).toBe(true);
    test.reporter.noteInteraction();
    await test.flush();
    expect(test.sent).toEqual([A]);
  });

  it("wants nothing while no connected node opted in", async () => {
    const test = harness(new Map([[A, config({ automaticUpdates: true })]]));
    test.disconnect(A);
    expect(test.reporter.wanted()).toBe(false);
    test.reporter.noteInteraction();
    await test.flush();
    expect(test.sent).toEqual([]);
  });

  it("sends at most one report per node every 30 seconds while there is input", async () => {
    const test = harness(
      new Map([
        [A, config({ automaticUpdates: true })],
        [B, config({ automaticUpdates: true })],
      ]),
    );
    test.reporter.noteInteraction();
    for (let elapsed = 0; elapsed < CLIENT_INTERACTION_REPORT_INTERVAL_MS - 2_000;) {
      test.advance(1_500);
      elapsed += 1_500;
      test.reporter.noteInteraction();
    }
    await test.flush();
    expect(test.sent).toEqual([A, B]);

    test.advance(2_000);
    test.reporter.noteInteraction();
    await test.flush();
    expect(test.sent).toEqual([A, B, A, B]);
  });

  it("does not look at the connections again within one burst of input", async () => {
    const configs = new Map([[A, config({ automaticUpdates: false })]]);
    const test = harness(configs);
    test.reporter.noteInteraction();
    configs.set(A, config({ automaticUpdates: true }));
    test.advance(500);
    test.reporter.noteInteraction();
    await test.flush();
    expect(test.sent).toEqual([]);
    test.advance(500);
    test.reporter.noteInteraction();
    await test.flush();
    expect(test.sent).toEqual([A]);
  });

  it("never throws into an input listener when a report fails", async () => {
    const reporter = createClientInteractionReporter({
      listConnections: () => [
        {
          environmentId: A,
          client: {
            server: {
              noteClientInteraction: () => {
                throw new Error("socket closed");
              },
            },
          },
        },
      ],
      readServerConfig: () => config({ automaticUpdates: true }),
      now: () => 0,
    });
    expect(() => reporter.noteInteraction()).not.toThrow();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  });
});
