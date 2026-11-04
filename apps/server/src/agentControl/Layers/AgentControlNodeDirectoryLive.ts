/**
 * AgentControlNodeDirectoryLive - the node directory owner clients publish, kept per publisher
 * in memory and in `<stateDir>/agent-control-node-directory.json`.
 *
 * Each publication replaces its publisher's previous one. Publisher keys are stored only as
 * sha-256 digests, so the file names no session. A relay caller's key changes with every
 * reconnect, so a publication naming exactly the same nodes as an older one replaces that one
 * too (the same client, republished under its new channel), and only the newest
 * {@link AGENT_CONTROL_NODE_DIRECTORY_MAX_PUBLISHERS} publications are kept: entries cannot
 * accumulate across reconnects. A publication expires
 * {@link AGENT_CONTROL_NODE_DIRECTORY_TTL_MS} after it was published.
 *
 * `list` merges the live publications by environment id, newest publication winning. Entries
 * naming this node by any of its ids collapse into one entry under its own id, marked
 * `isThisNode` and online. Its ids are its server environment id and, while it holds an active
 * Hub enrollment, the Hub environment id hosted clients key it by (read per `list`, since a Hub
 * leave or re-enrollment changes it).
 *
 * Its file is read once, when the directory is built: on the server, with the first publication
 * or listing (`AgentControlNodeDirectoryDeferredLive`). An unreadable file, or records in it
 * that no longer decode, are dropped with a warning: clients publish again on connect.
 *
 * @module AgentControlNodeDirectoryLive
 */
import {
  AGENT_CONTROL_NODE_DIRECTORY_MAX_ENTRIES,
  AgentControlNodeDirectoryEntry,
  type AgentControlNodeDirectoryListEntry,
  EnvironmentId,
  IsoDateTime,
} from "@ryco/contracts";
import { Clock, Effect, FileSystem, Layer, Option, Path, Ref, Schema } from "effect";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { sha256Hex } from "../../canonicalJson.ts";
import { ServerConfig } from "../../config.ts";
import { ServerEnvironment } from "../../environment/Services/ServerEnvironment.ts";
import { AgentControlNodeDirectoryError } from "../Errors.ts";
import {
  AgentControlNodeDirectory,
  type AgentControlNodeDirectoryShape,
} from "../Services/AgentControlNodeDirectory.ts";

export const AGENT_CONTROL_NODE_DIRECTORY_FILE_NAME = "agent-control-node-directory.json";
/** A publication no client has repeated for this long is dropped. */
export const AGENT_CONTROL_NODE_DIRECTORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Publications kept at once, newest first; older ones are dropped. */
export const AGENT_CONTROL_NODE_DIRECTORY_MAX_PUBLISHERS = 16;

/** One publisher's latest publication. */
interface Publication {
  /** sha-256 of the publisher key. */
  readonly publisher: string;
  readonly publishedAtMs: number;
  /** Distinct environment ids, at most `AGENT_CONTROL_NODE_DIRECTORY_MAX_ENTRIES`. */
  readonly nodes: ReadonlyArray<AgentControlNodeDirectoryEntry>;
}

/**
 * The file keeps publications and their entries as unknown values so one record that no longer
 * decodes is dropped on its own instead of taking the whole directory with it.
 */
const PersistedNodeDirectory = Schema.Struct({
  version: Schema.Literal(1),
  publications: Schema.Array(Schema.Unknown),
});
const PersistedPublication = Schema.Struct({
  publisher: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  publishedAt: IsoDateTime,
  nodes: Schema.Array(Schema.Unknown),
});
const decodePersistedNodeDirectory = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersistedNodeDirectory),
);
const decodePersistedPublication = Schema.decodeUnknownOption(PersistedPublication);
const decodeEntry = Schema.decodeUnknownOption(AgentControlNodeDirectoryEntry);

const storageError = (detail: string) =>
  new AgentControlNodeDirectoryError({ reason: "storage", detail });

const isLive = (publication: Publication, nowMs: number): boolean =>
  nowMs - publication.publishedAtMs < AGENT_CONTROL_NODE_DIRECTORY_TTL_MS;

/** Declared fields only, first entry per environment id, at most the per-publication bound. */
const normalizeNodes = (
  nodes: Iterable<AgentControlNodeDirectoryEntry>,
): ReadonlyArray<AgentControlNodeDirectoryEntry> => {
  const kept = new Map<EnvironmentId, AgentControlNodeDirectoryEntry>();
  for (const node of nodes) {
    if (kept.size >= AGENT_CONTROL_NODE_DIRECTORY_MAX_ENTRIES) break;
    if (kept.has(node.environmentId)) continue;
    kept.set(node.environmentId, {
      environmentId: node.environmentId,
      label: node.label,
      platformOs: node.platformOs,
      online: node.online,
      projectCopySupport: node.projectCopySupport,
      ...(node.transport === undefined ? {} : { transport: node.transport }),
      ...(node.defaultProjectDirectory === undefined
        ? {}
        : { defaultProjectDirectory: node.defaultProjectDirectory }),
      ...(node.projects === undefined
        ? {}
        : {
            projects: node.projects.map((project) => ({
              repositoryCanonicalKey: project.repositoryCanonicalKey,
              path: project.path,
            })),
          }),
    });
  }
  return [...kept.values()];
};

/** Identifies the set of nodes a publication names, whatever their order or details. */
const nodeSetKey = (nodes: ReadonlyArray<AgentControlNodeDirectoryEntry>): string =>
  nodes
    .map((node) => node.environmentId)
    .toSorted()
    .join("\n");

/** Live publications, oldest first, at most the newest `AGENT_CONTROL_NODE_DIRECTORY_MAX_PUBLISHERS`. */
const boundPublications = (
  publications: ReadonlyArray<Publication>,
  nowMs: number,
): ReadonlyArray<Publication> =>
  publications
    .filter((publication) => isLive(publication, nowMs))
    .slice(-AGENT_CONTROL_NODE_DIRECTORY_MAX_PUBLISHERS);

/**
 * The publications after `next` replaced its publisher's previous one and any older one naming
 * the same nodes. An empty publication only withdraws the publisher's previous one.
 */
const applyPublication = (
  publications: ReadonlyArray<Publication>,
  next: Publication,
): ReadonlyArray<Publication> => {
  const setKey = nodeSetKey(next.nodes);
  const kept = publications.filter(
    (publication) =>
      publication.publisher !== next.publisher &&
      (next.nodes.length === 0 || nodeSetKey(publication.nodes) !== setKey),
  );
  const withNext = next.nodes.length === 0 ? kept : [...kept, next];
  return boundPublications(withNext, next.publishedAtMs);
};

/**
 * One entry per node across the live publications, the newest publication winning. Entries naming
 * this node by any of its ids become one entry under `thisNode.environmentId`.
 */
const mergeNodeDirectory = (
  publications: ReadonlyArray<Publication>,
  options: {
    readonly nowMs: number;
    readonly thisNode: {
      readonly environmentId: EnvironmentId;
      readonly aliases: ReadonlySet<EnvironmentId>;
    };
  },
): ReadonlyArray<AgentControlNodeDirectoryListEntry> => {
  const { thisNode } = options;
  const merged = new Map<EnvironmentId, AgentControlNodeDirectoryListEntry>();
  // Oldest first, so a later publication overwrites what an earlier one said.
  for (const publication of publications) {
    if (!isLive(publication, options.nowMs)) continue;
    const lastPublishedAt = new Date(publication.publishedAtMs).toISOString();
    for (const node of publication.nodes) {
      const isThisNode =
        node.environmentId === thisNode.environmentId || thisNode.aliases.has(node.environmentId);
      const environmentId = isThisNode ? thisNode.environmentId : node.environmentId;
      merged.set(environmentId, {
        ...node,
        environmentId,
        // This node is answering; a publisher's view of it may be stale.
        online: isThisNode || node.online,
        isThisNode,
        lastPublishedAt,
      });
    }
  }
  return [...merged.values()].toSorted(
    (left, right) =>
      Number(right.isThisNode) - Number(left.isThisNode) ||
      left.label.localeCompare(right.label) ||
      left.environmentId.localeCompare(right.environmentId),
  );
};

const encodePublications = (publications: ReadonlyArray<Publication>): string =>
  `${JSON.stringify({
    version: 1,
    publications: publications.map((publication) => ({
      publisher: publication.publisher,
      publishedAt: new Date(publication.publishedAtMs).toISOString(),
      nodes: publication.nodes,
    })),
  })}\n`;

/** Valid records only, oldest first; a time in the future counts as now. */
const decodePublications = (
  records: ReadonlyArray<unknown>,
  nowMs: number,
): { readonly publications: ReadonlyArray<Publication>; readonly dropped: number } => {
  const publications: Array<Publication> = [];
  let dropped = 0;
  for (const record of records) {
    const decoded = decodePersistedPublication(record);
    const publishedAtMs = Option.isSome(decoded) ? Date.parse(decoded.value.publishedAt) : NaN;
    if (Option.isNone(decoded) || !Number.isFinite(publishedAtMs)) {
      dropped += 1;
      continue;
    }
    const entries = decoded.value.nodes.flatMap((node) => Option.toArray(decodeEntry(node)));
    dropped += decoded.value.nodes.length - entries.length;
    const nodes = normalizeNodes(entries);
    if (nodes.length === 0) continue;
    publications.push({
      publisher: decoded.value.publisher,
      publishedAtMs: Math.min(publishedAtMs, nowMs),
      nodes,
    });
  }
  return {
    publications: boundPublications(
      publications.toSorted((left, right) => left.publishedAtMs - right.publishedAtMs),
      nowMs,
    ),
    dropped,
  };
};

const loadPublications = (filePath: string, nowMs: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(filePath))) return [];
    const raw = yield* fs.readFileString(filePath);
    const decoded = yield* decodePersistedNodeDirectory(raw).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("agent-control.node-directory-unreadable", {
          path: filePath,
          cause,
        }).pipe(Effect.as(null)),
      ),
    );
    if (decoded === null) return [];
    const { publications, dropped } = decodePublications(decoded.publications, nowMs);
    if (dropped > 0) {
      yield* Effect.logWarning("agent-control.node-directory-records-dropped", {
        path: filePath,
        dropped,
      });
    }
    return publications;
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("agent-control.node-directory-read-failed", {
        path: filePath,
        cause,
      }).pipe(Effect.as([] as ReadonlyArray<Publication>)),
    ),
  );

export interface MakeAgentControlNodeDirectoryOptions {
  readonly filePath: string;
  readonly thisNodeEnvironmentId: EnvironmentId;
  /** Other ids clients may know this node by, read on every `list`; none by default. */
  readonly thisNodeAliases?: Effect.Effect<ReadonlySet<EnvironmentId>>;
}

const NO_ALIASES: ReadonlySet<EnvironmentId> = new Set();

/**
 * The Hub environment id of this node while it is enrolled, from its Hub identity state. The
 * identity module loads only when a directory is listed, so a boot never pays for it.
 */
const readHubEnvironmentAliases = (statePath: string): Effect.Effect<ReadonlySet<EnvironmentId>> =>
  Effect.promise(async () => {
    const { readActiveHubEnvironmentId } =
      await import("../../hubIdentity/LocalHubIdentityState.ts");
    const hubEnvironmentId = await readActiveHubEnvironmentId(statePath);
    return hubEnvironmentId === null ? NO_ALIASES : new Set([EnvironmentId.make(hubEnvironmentId)]);
  }).pipe(Effect.orElseSucceed(() => NO_ALIASES));

export const makeAgentControlNodeDirectory = Effect.fn("makeAgentControlNodeDirectory")(function* (
  options: MakeAgentControlNodeDirectoryOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const readAliases = options.thisNodeAliases ?? Effect.succeed(NO_ALIASES);
  const state = yield* Ref.make(
    yield* loadPublications(options.filePath, yield* Clock.currentTimeMillis),
  );
  // One publication at a time: each writes the whole file, and the in-memory state only moves
  // once its write landed, so what `list` answers is what a restart reads back.
  const publishLock = yield* Semaphore.make(1);

  const persist = (publications: ReadonlyArray<Publication>) =>
    writeFileStringAtomically({
      filePath: options.filePath,
      contents: encodePublications(publications),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.tapError((cause) =>
        Effect.logWarning("agent-control.node-directory-write-failed", {
          path: options.filePath,
          cause,
        }),
      ),
      Effect.mapError(() => storageError("The node directory could not be stored.")),
    );

  const publish: AgentControlNodeDirectoryShape["publish"] = (input) => {
    const publisher = sha256Hex(input.publisherKey);
    const nodes = normalizeNodes(input.nodes);
    return publishLock.withPermits(1)(
      Effect.gen(function* () {
        const publishedAtMs = yield* Clock.currentTimeMillis;
        const next = applyPublication(yield* Ref.get(state), {
          publisher,
          publishedAtMs,
          nodes,
        });
        yield* persist(next);
        yield* Ref.set(state, next);
        return { accepted: nodes.length };
      }),
    );
  };

  const list: AgentControlNodeDirectoryShape["list"] = () =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const thisNode = {
        environmentId: options.thisNodeEnvironmentId,
        aliases: yield* readAliases,
      };
      return { nodes: mergeNodeDirectory(yield* Ref.get(state), { nowMs, thisNode }) };
    });

  return AgentControlNodeDirectory.of({ publish, list });
});

/** The server's directory: in its state directory, this node known by its Hub id as well. */
export const makeServerAgentControlNodeDirectory = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const environment = yield* ServerEnvironment;
  const path = yield* Path.Path;
  return yield* makeAgentControlNodeDirectory({
    filePath: path.join(config.stateDir, AGENT_CONTROL_NODE_DIRECTORY_FILE_NAME),
    thisNodeEnvironmentId: yield* environment.getEnvironmentId,
    thisNodeAliases: readHubEnvironmentAliases(config.hubIdentityStatePath),
  });
});

/**
 * Builds the directory with the layer, reading its file at once. The server uses
 * `AgentControlNodeDirectoryDeferredLive`, which loads this module on first use.
 */
export const AgentControlNodeDirectoryLive = Layer.effect(
  AgentControlNodeDirectory,
  makeServerAgentControlNodeDirectory,
);
