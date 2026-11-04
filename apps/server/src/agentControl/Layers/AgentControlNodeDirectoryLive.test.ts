import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AGENT_CONTROL_NODE_DIRECTORY_MAX_ENTRIES,
  type AgentControlNodeDirectoryEntry,
  EnvironmentId,
} from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { TestClock } from "effect/testing";

import { ServerConfig } from "../../config.ts";
import { ServerEnvironment } from "../../environment/Services/ServerEnvironment.ts";
import { AgentControlNodeDirectory } from "../Services/AgentControlNodeDirectory.ts";
import {
  AGENT_CONTROL_NODE_DIRECTORY_FILE_NAME,
  AGENT_CONTROL_NODE_DIRECTORY_MAX_PUBLISHERS,
  AGENT_CONTROL_NODE_DIRECTORY_TTL_MS,
  AgentControlNodeDirectoryLive,
  makeAgentControlNodeDirectory,
  type MakeAgentControlNodeDirectoryOptions,
} from "./AgentControlNodeDirectoryLive.ts";

const START = Date.parse("2026-10-22T08:00:00.000Z");
const THIS_NODE = EnvironmentId.make("node-self");
const THIS_NODE_HUB_ALIAS = EnvironmentId.make("env_selfselfselfselfselfse");

const entry = (
  id: string,
  overrides: Partial<AgentControlNodeDirectoryEntry> = {},
): AgentControlNodeDirectoryEntry => ({
  environmentId: EnvironmentId.make(id),
  label: `Node ${id}`,
  platformOs: "darwin",
  online: true,
  projectCopySupport: "yes",
  ...overrides,
});

const withDirectory = <A, E, R>(
  use: (input: {
    readonly filePath: string;
    readonly open: (
      options?: Partial<MakeAgentControlNodeDirectoryOptions>,
    ) => ReturnType<typeof makeAgentControlNodeDirectory>;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-node-directory-" });
    const filePath = path.join(directory, AGENT_CONTROL_NODE_DIRECTORY_FILE_NAME);
    return yield* use({
      filePath,
      open: (options) =>
        makeAgentControlNodeDirectory({
          filePath,
          thisNodeEnvironmentId: THIS_NODE,
          ...options,
        }),
    });
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer()));

const ids = (nodes: ReadonlyArray<{ readonly environmentId: string }>) =>
  nodes.map((node) => node.environmentId);

it.layer(NodeServices.layer)("AgentControlNodeDirectoryLive", (it) => {
  it.effect("merges publishers by environment id, the newest publication winning", () =>
    withDirectory(({ open }) =>
      Effect.gen(function* () {
        const directory = yield* open();
        yield* directory.publish({
          publisherKey: "desktop",
          nodes: [entry("a", { label: "Mac mini" }), entry("b"), entry(THIS_NODE)],
        });
        yield* TestClock.adjust("1 minute");
        yield* directory.publish({
          publisherKey: "hosted",
          nodes: [entry("a", { label: "Mac mini (renamed)", online: false }), entry("c")],
        });

        const listed = yield* directory.list();
        // This node first, then by label.
        assert.deepStrictEqual(ids(listed.nodes), [THIS_NODE, "a", "b", "c"]);
        const byId = new Map(listed.nodes.map((node) => [node.environmentId, node]));
        assert.deepStrictEqual(byId.get(EnvironmentId.make("a")), {
          ...entry("a", { label: "Mac mini (renamed)", online: false }),
          isThisNode: false,
          lastPublishedAt: "2026-10-22T08:01:00.000Z",
        });
        assert.strictEqual(
          byId.get(EnvironmentId.make("b"))?.lastPublishedAt,
          new Date(START).toISOString(),
        );
        assert.isTrue(byId.get(THIS_NODE)?.isThisNode);

        // A publisher's next publication replaces its previous one, and wins as the newest.
        yield* directory.publish({
          publisherKey: "desktop",
          nodes: [entry("a", { label: "Mac mini" })],
        });
        const republished = yield* directory.list();
        assert.deepStrictEqual(ids(republished.nodes), ["a", "c"]);
        assert.strictEqual(republished.nodes[0]?.label, "Mac mini");

        // An empty publication withdraws the publisher's entries.
        yield* directory.publish({ publisherKey: "desktop", nodes: [] });
        yield* directory.publish({ publisherKey: "hosted", nodes: [] });
        assert.deepStrictEqual((yield* directory.list()).nodes, []);
      }),
    ),
  );

  it.effect("collapses this node's ids into one online entry", () =>
    withDirectory(({ open }) =>
      Effect.gen(function* () {
        let aliases: ReadonlySet<EnvironmentId> = new Set([THIS_NODE_HUB_ALIAS]);
        const directory = yield* open({ thisNodeAliases: Effect.sync(() => aliases) });
        yield* directory.publish({
          publisherKey: "desktop",
          nodes: [entry(THIS_NODE, { label: "Studio", online: false, platformOs: "linux" })],
        });
        yield* TestClock.adjust("1 second");
        yield* directory.publish({
          publisherKey: "hosted",
          nodes: [
            entry(THIS_NODE_HUB_ALIAS, { label: "Studio · K3QF", online: false }),
            entry("b"),
          ],
        });

        const listed = yield* directory.list();
        assert.deepStrictEqual(listed.nodes[0], {
          ...entry(THIS_NODE, { label: "Studio · K3QF" }),
          isThisNode: true,
          lastPublishedAt: "2026-10-22T08:00:01.000Z",
        });
        assert.deepStrictEqual(ids(listed.nodes), [THIS_NODE, "b"]);

        // Read on every list: once the node left the Hub, that id is another node's.
        aliases = new Set();
        const afterLeave = yield* directory.list();
        assert.deepStrictEqual(ids(afterLeave.nodes), [THIS_NODE, "b", THIS_NODE_HUB_ALIAS]);
        assert.isFalse(afterLeave.nodes[2]?.isThisNode);
      }),
    ),
  );

  it.effect("expires publications 30 days after they were published", () =>
    withDirectory(({ filePath, open }) =>
      Effect.gen(function* () {
        const directory = yield* open();
        yield* directory.publish({ publisherKey: "old", nodes: [entry("a")] });
        yield* TestClock.adjust("1 day");
        yield* directory.publish({ publisherKey: "new", nodes: [entry("b")] });

        yield* TestClock.adjust(AGENT_CONTROL_NODE_DIRECTORY_TTL_MS - 24 * 60 * 60 * 1000 - 1);
        assert.deepStrictEqual(ids((yield* directory.list()).nodes), ["a", "b"]);
        yield* TestClock.adjust(1);
        assert.deepStrictEqual(ids((yield* directory.list()).nodes), ["b"]);

        // The next publication drops the expired one from the file as well.
        yield* directory.publish({ publisherKey: "new", nodes: [entry("b"), entry("c")] });
        const fs = yield* FileSystem.FileSystem;
        const stored = JSON.parse(yield* fs.readFileString(filePath));
        assert.strictEqual(stored.publications.length, 1);

        // A restart after every publication expired starts empty.
        yield* TestClock.adjust(AGENT_CONTROL_NODE_DIRECTORY_TTL_MS);
        assert.deepStrictEqual((yield* (yield* open()).list()).nodes, []);
      }),
    ),
  );

  it.effect("bounds entries per publication and the publishers it keeps", () =>
    withDirectory(({ open }) =>
      Effect.gen(function* () {
        const directory = yield* open();
        const many = Array.from(
          { length: AGENT_CONTROL_NODE_DIRECTORY_MAX_ENTRIES + 5 },
          (_, index) => entry(`n${String(index).padStart(3, "0")}`),
        );
        const accepted = yield* directory.publish({
          publisherKey: "many",
          nodes: [entry("n000", { label: "Duplicate" }), ...many],
        });
        // Duplicates count once, the first one wins, and the rest is cut at the bound.
        assert.deepStrictEqual(accepted, { accepted: AGENT_CONTROL_NODE_DIRECTORY_MAX_ENTRIES });
        const listed = yield* directory.list();
        assert.strictEqual(listed.nodes.length, AGENT_CONTROL_NODE_DIRECTORY_MAX_ENTRIES);
        assert.strictEqual(
          listed.nodes.find((node) => node.environmentId === "n000")?.label,
          "Duplicate",
        );

        // A relay caller publishes under a new key after every reconnect: the same nodes replace
        // the publication they repeat instead of adding to it.
        yield* directory.publish({ publisherKey: "many", nodes: [] });
        for (let reconnect = 0; reconnect < 40; reconnect += 1) {
          yield* TestClock.adjust("1 minute");
          yield* directory.publish({
            publisherKey: `relay-scope-${reconnect}`,
            nodes: [entry("b", { online: reconnect % 2 === 0 }), entry("a")],
          });
        }
        assert.deepStrictEqual(ids((yield* directory.list()).nodes), ["a", "b"]);

        // Distinct publishers beyond the bound push out the oldest ones.
        for (
          let publisher = 0;
          publisher < AGENT_CONTROL_NODE_DIRECTORY_MAX_PUBLISHERS;
          publisher += 1
        ) {
          yield* TestClock.adjust("1 second");
          yield* directory.publish({
            publisherKey: `p${publisher}`,
            nodes: [entry(`only-${publisher}`)],
          });
        }
        const bounded = ids((yield* directory.list()).nodes);
        assert.strictEqual(bounded.length, AGENT_CONTROL_NODE_DIRECTORY_MAX_PUBLISHERS);
        assert.notInclude(bounded, "a");
      }),
    ),
  );

  it.effect("persists across restarts without naming the publishers", () =>
    withDirectory(({ filePath, open }) =>
      Effect.gen(function* () {
        const first = yield* open();
        yield* first.publish({
          publisherKey: "session-owner-secretish",
          nodes: [entry("a", { platformOs: "windows", projectCopySupport: "unknown" })],
        });
        yield* TestClock.adjust("5 minutes");
        yield* first.publish({
          publisherKey: "relay-scope-1",
          nodes: [entry("b", { online: false })],
        });
        const before = yield* first.list();

        const raw = yield* (yield* FileSystem.FileSystem).readFileString(filePath);
        assert.notInclude(raw, "session-owner-secretish");
        assert.notInclude(raw, "relay-scope-1");

        const restarted = yield* open();
        assert.deepStrictEqual(yield* restarted.list(), before);

        // The restarted directory still replaces each publisher's own publication.
        yield* restarted.publish({ publisherKey: "relay-scope-1", nodes: [entry("c")] });
        assert.deepStrictEqual(ids((yield* restarted.list()).nodes), ["a", "c"]);
      }),
    ),
  );

  it.effect(
    "keeps how a node is reached, its code directory and its projects, across restarts",
    () =>
      withDirectory(({ open }) =>
        Effect.gen(function* () {
          const first = yield* open();
          const published = entry("a", {
            transport: "relay",
            defaultProjectDirectory: "/Users/me/code",
            projects: [{ repositoryCanonicalKey: "github.com/me/app", path: "/Users/me/code/app" }],
          });
          yield* first.publish({ publisherKey: "desktop", nodes: [published, entry("b")] });
          const listed = (yield* first.list()).nodes;
          assert.deepInclude(listed[0], published);
          // A node published without them says nothing about them.
          assert.isFalse("projects" in listed[1]!);
          assert.isFalse("transport" in listed[1]!);
          assert.deepStrictEqual((yield* (yield* open()).list()).nodes, listed);
        }),
      ),
  );

  it.effect("recovers from a corrupt file and drops only the records that do not decode", () =>
    withDirectory(({ filePath, open }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(filePath, "{ not json");
        const directory = yield* open();
        assert.deepStrictEqual((yield* directory.list()).nodes, []);
        yield* directory.publish({ publisherKey: "a", nodes: [entry("a")] });
        assert.deepStrictEqual(ids((yield* (yield* open()).list()).nodes), ["a"]);

        const publisher = "0".repeat(64);
        yield* fs.writeFileString(
          filePath,
          JSON.stringify({
            version: 1,
            publications: [
              // Valid, apart from one entry with an undeclared key and one with a bad platform.
              {
                publisher,
                publishedAt: "2026-10-22T07:00:00.000Z",
                nodes: [
                  entry("kept"),
                  { ...entry("extra"), address: "10.0.0.2" },
                  { ...entry("bad"), platformOs: "beos" },
                ],
              },
              { publisher: "not-a-digest", publishedAt: "2026-10-22T07:00:00.000Z", nodes: [] },
              { publisher, publishedAt: "yesterday", nodes: [entry("no-time")] },
              // Published "in the future": counts as now, so it neither wins forever nor lives forever.
              {
                publisher: "1".repeat(64),
                publishedAt: "2030-01-01T00:00:00.000Z",
                nodes: [entry("future")],
              },
              "garbage",
            ],
          }),
        );
        const listed = (yield* (yield* open()).list()).nodes;
        assert.deepStrictEqual(ids(listed), ["future", "kept"]);
        assert.strictEqual(
          listed.find((node) => node.environmentId === "future")?.lastPublishedAt,
          new Date(START).toISOString(),
        );

        yield* fs.writeFileString(filePath, JSON.stringify({ version: 2, publications: [] }));
        assert.deepStrictEqual((yield* (yield* open()).list()).nodes, []);
      }),
    ),
  );

  it.effect("fails a publication it cannot store and keeps the previous state", () =>
    withDirectory(({ filePath, open }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // The directory meant for the file is a file, so neither reading nor writing works.
        const blocker = path.join(path.dirname(filePath), "blocker");
        yield* fs.writeFileString(blocker, "");
        const directory = yield* open({ filePath: path.join(blocker, "directory.json") });
        assert.deepStrictEqual((yield* directory.list()).nodes, []);

        const failure = yield* Effect.flip(
          directory.publish({ publisherKey: "a", nodes: [entry("a")] }),
        );
        assert.strictEqual(failure._tag, "AgentControlNodeDirectoryError");
        assert.strictEqual(failure.reason, "storage");
        assert.deepStrictEqual((yield* directory.list()).nodes, []);
      }),
    ),
  );

  it.effect("keeps the file in the state directory and knows this node by its environment id", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-node-directory-live-" });
      const layer = AgentControlNodeDirectoryLive.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            ServerConfig.layerTest(process.cwd(), baseDir),
            Layer.succeed(
              ServerEnvironment,
              ServerEnvironment.of({
                getEnvironmentId: Effect.succeed(THIS_NODE),
                getDescriptor: Effect.die("unused"),
              }),
            ),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const directory = yield* AgentControlNodeDirectory;
        const config = yield* ServerConfig;
        yield* directory.publish({
          publisherKey: "owner",
          nodes: [entry(THIS_NODE), entry(THIS_NODE_HUB_ALIAS, { label: "Studio · Hub" })],
        });
        // Not enrolled with a Hub: its Hub id is not known to be this node.
        const before = yield* directory.list();
        assert.deepStrictEqual(
          before.nodes.map((node) => [node.environmentId, node.isThisNode]),
          [
            [THIS_NODE, true],
            [THIS_NODE_HUB_ALIAS, false],
          ],
        );
        assert.isTrue(
          yield* fs.exists(path.join(config.stateDir, AGENT_CONTROL_NODE_DIRECTORY_FILE_NAME)),
        );

        // Enrolled: the id the Hub knows it by collapses into this node.
        const hubEnvironmentId = yield* Effect.promise(async () => {
          const { makeLocalHubIdentityStateStore } =
            await import("../../hubIdentity/LocalHubIdentityState.ts");
          const store = await makeLocalHubIdentityStateStore(config.hubIdentityStatePath);
          await store.readOrCreate();
          const enrolled = await store.update((state) => ({
            ...state,
            revision: state.revision + 1,
            activeNode: {
              hubOrigin: "https://hub.example.com",
              nodeId: `node_${"a".repeat(22)}`,
              activeKeyId: `nkey_${"b".repeat(22)}`,
              activeKeySecretName: "node-key.active",
              cleanupPollingSecretName: null,
              enrolledAt: 1,
            },
          }));
          return EnvironmentId.make(enrolled.environmentId);
        });
        yield* directory.publish({
          publisherKey: "hosted",
          nodes: [entry(hubEnvironmentId, { label: "Studio · Hub" })],
        });
        const after = yield* directory.list();
        assert.deepStrictEqual(
          after.nodes.map((node) => [node.environmentId, node.isThisNode]),
          [
            [THIS_NODE, true],
            [THIS_NODE_HUB_ALIAS, false],
          ],
        );
        assert.strictEqual(after.nodes[0]?.label, "Studio · Hub");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
  );
});
