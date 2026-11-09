import {
  createProjectCopyJobRecord,
  reduceProjectCopyJobRecord,
  type CopyDestinationSuggestion,
  type ProjectCopyProgress,
} from "./index.ts";
import { describeOfflineSince } from "@ryco/client-runtime/connection";
import type { NodeCatalogEntry } from "@ryco/client-runtime/state/nodes";
import { EnvironmentId, ProjectId } from "@ryco/contracts";
import { ProjectImportId, type ProjectImportSnapshot } from "@ryco/contracts/project-copy";
import { describe, expect, it } from "vite-plus/test";

import {
  copyAlreadyOn,
  copyConnectionCapReason,
  copyDestinationCards,
  copyFolderNote,
  copyFolderTag,
  copyOptionsSummary,
  copyOverallPercent,
  copyProgressFooter,
  copyProgressSteps,
  copySegmentsText,
  copySourceRows,
  copyNoTargetMessage,
  copyTargetCards,
  initialCopySource,
  initialCopyTarget,
  nodesHeldByCopy,
  parentOfNodePath,
  projectCopyRows,
  shortSetupCommand,
  type CopyProgressContext,
  type ProjectCopyEntryLike,
} from "./dialog.ts";

const LAPTOP = EnvironmentId.make("env-laptop");
const MINI = EnvironmentId.make("env-mini");
const HETZNER = EnvironmentId.make("env-hetzner");
const GAMING = EnvironmentId.make("env-gaming");
const OLD = EnvironmentId.make("env-old");
const SOURCE = ProjectId.make("project-source");
const NEW = ProjectId.make("project-new");
const NOW = Date.parse("2026-10-22T12:00:00Z");

function node(environmentId: EnvironmentId, label: string, patch: Partial<NodeCatalogEntry> = {}) {
  return {
    environmentId,
    label,
    isPrimary: false,
    isThisDevice: false,
    presence: "online",
    platformOs: "darwin",
    iconKind: null,
    canMutate: true,
    mutateBlockedReason: null,
    projectCopySupport: "yes",
    transport: "direct",
    lastSeenAt: null,
    ...patch,
  } satisfies NodeCatalogEntry;
}

const NODES = [
  node(LAPTOP, "MacBook Pro"),
  node(MINI, "Mac mini"),
  node(HETZNER, "hetzner-build", { platformOs: "linux" }),
  node(GAMING, "Gaming PC", { presence: "offline", lastSeenAt: NOW - 2 * 3_600_000 }),
  node(OLD, "Old box", { projectCopySupport: "no" }),
];

const MEMBERS = [
  { environmentId: LAPTOP, id: SOURCE, cwd: "/Users/me/Code/ryco" },
  { environmentId: MINI, id: ProjectId.make("project-mini"), cwd: "/Users/me/dev/ryco" },
];

describe("From and To", () => {
  it("lists every checkout and disables offline ones", () => {
    const rows = copySourceRows({
      members: [
        ...MEMBERS,
        { environmentId: GAMING, id: ProjectId.make("p"), cwd: "C:\\Code\\ryco" },
      ],
      nodes: NODES,
      labelOf: () => "Device",
    });
    expect(rows.map((row) => [row.label, row.displayPath, row.selectable])).toEqual([
      ["MacBook Pro", "~/Code/ryco", true],
      ["Mac mini", "~/dev/ryco", true],
      ["Gaming PC", "C:\\Code\\ryco", false],
    ]);
    // An offline source asked for falls back to the first reachable one.
    expect(
      initialCopySource(rows, { environmentId: GAMING, projectId: ProjectId.make("p") })?.label,
    ).toBe("MacBook Pro");
  });

  it("describes each destination and picks the first ready one", () => {
    const cards = copyTargetCards({ nodes: NODES, members: MEMBERS, nowMs: NOW });
    expect(cards.map((card) => [card.node.label, card.state, card.selectable, card.sub])).toEqual([
      ["MacBook Pro", "has-it", false, "has it · ~/Code/ryco"],
      ["Mac mini", "has-it", false, "has it · ~/dev/ryco"],
      ["hetzner-build", "ready", true, "Linux"],
      [
        "Gaming PC",
        "offline",
        false,
        `offline ${describeOfflineSince(NOW - 2 * 3_600_000, { nowMs: NOW })}`,
      ],
      ["Old box", "outdated", false, "Update Ryco on Old box to copy here"],
    ]);
    expect(initialCopyTarget(cards, MINI)).toBe(HETZNER);
    expect(initialCopyTarget(cards, null)).toBe(HETZNER);
    // Nodes that have it are named in the "Already on" line, not given a card.
    expect(copyDestinationCards(cards).map((card) => card.node.label)).toEqual([
      "hetzner-build",
      "Gaming PC",
      "Old box",
    ]);
    expect(copyAlreadyOn(cards).map((card) => card.node.label)).toEqual([
      "MacBook Pro",
      "Mac mini",
    ]);
  });

  it("preselects the destination last copied to when it can take the copy", () => {
    const cards = copyTargetCards({
      nodes: [...NODES, node(EnvironmentId.make("env-box"), "box", { platformOs: "linux" })],
      members: MEMBERS,
      nowMs: NOW,
    });
    const box = EnvironmentId.make("env-box");
    expect(initialCopyTarget(cards, null, box)).toBe(box);
    // The one asked for wins; one that can't take it falls back to the usual rule.
    expect(initialCopyTarget(cards, HETZNER, box)).toBe(HETZNER);
    expect(initialCopyTarget(cards, null, GAMING)).toBe(HETZNER);
    expect(initialCopyTarget(cards, null, MINI)).toBe(HETZNER);
  });

  it("says why no destination can take the copy", () => {
    const cards = copyTargetCards({
      nodes: [node(MINI, "Mac mini"), node(GAMING, "Gaming PC", { presence: "offline" })],
      members: MEMBERS,
      nowMs: NOW,
    });
    // Every online node has it.
    expect(copyNoTargetMessage("ryco", cards)).toBe(
      "ryco is already on every online node. Add a node to copy it somewhere new.",
    );

    // The other node runs an older Ryco, or can't be changed from here: not "already on every node".
    const blocked = copyTargetCards({
      nodes: [
        node(MINI, "Mac mini"),
        node(HETZNER, "Old box", { projectCopySupport: "no" }),
        node(GAMING, "hetzner-build", {
          canMutate: false,
          mutateBlockedReason: "Pair hetzner-build again as its owner",
        }),
      ],
      members: MEMBERS,
      nowMs: NOW,
    });
    expect(blocked.every((card) => !card.selectable)).toBe(true);
    expect(copyNoTargetMessage("ryco", blocked)).toBe(
      "No node can take a copy of ryco right now. Update Ryco on Old box to copy here. Pair hetzner-build again as its owner.",
    );
  });

  it("keeps a node that is not connected yet selectable", () => {
    const cards = copyTargetCards({
      nodes: [node(HETZNER, "hetzner-build", { projectCopySupport: "unknown", transport: null })],
      members: MEMBERS,
      nowMs: NOW,
    });
    expect(cards[0]).toMatchObject({ state: "unknown", selectable: true });
    expect(initialCopyTarget(cards, HETZNER)).toBe(HETZNER);
  });

  it("disables a node this client can't change", () => {
    const cards = copyTargetCards({
      nodes: [
        node(HETZNER, "hetzner-build", {
          canMutate: false,
          mutateBlockedReason: "Pair hetzner-build again as its owner",
        }),
      ],
      members: [],
      nowMs: NOW,
    });
    expect(cards[0]).toMatchObject({
      state: "blocked",
      selectable: false,
      reason: "Pair hetzner-build again as its owner",
    });
  });
});

function suggestion(patch: Partial<CopyDestinationSuggestion>): CopyDestinationSuggestion {
  return {
    path: "/home/me/Code/ryco",
    status: "available",
    basis: "same-place",
    missingMirroredParent: null,
    takenPath: null,
    existingProjectId: null,
    detail: null,
    preview: {
      resolvedPath: "/home/me/Code/ryco",
      state: "available",
      existingProjectId: null,
      existingRepositoryCanonicalKey: null,
      suggestedPath: null,
      detail: null,
    },
    ...patch,
  };
}

const noteText = (input: Parameters<typeof copyFolderNote>[0]) =>
  copySegmentsText(copyFolderNote(input).segments);
const NOTE = {
  manual: false,
  sourceLabel: "MacBook Pro",
  targetLabel: "hetzner-build",
  targetHome: "/home/me",
  projectTitle: "ryco",
};

describe("the destination folder", () => {
  it("says why the suggestion is where it is", () => {
    expect(noteText({ ...NOTE, suggestion: suggestion({}) })).toBe("Same place as on MacBook Pro.");
    expect(
      noteText({
        ...NOTE,
        suggestion: suggestion({
          basis: "default-directory",
          missingMirroredParent: "/home/me/dev",
        }),
      }),
    ).toBe("~/dev doesn’t exist on hetzner-build, so this uses ~/Code instead.");
    expect(noteText({ ...NOTE, suggestion: suggestion({ basis: "default-directory" }) })).toBe(
      "Uses ~/Code, the code folder on hetzner-build.",
    );
    expect(noteText({ ...NOTE, manual: true, suggestion: suggestion({}) })).toBe(
      "You picked this folder.",
    );
    expect(noteText({ ...NOTE, manual: true, remembered: true, suggestion: suggestion({}) })).toBe(
      "The folder you used last time.",
    );
    expect(noteText({ ...NOTE, suggestion: null })).toBe("Checking hetzner-build…");
  });

  it("names a refused folder in the negative tone", () => {
    const note = copyFolderNote({
      ...NOTE,
      suggestion: suggestion({ status: "blocked", detail: "Access to /srv is not allowed" }),
    });
    expect(note.tone).toBe("negative");
    expect(copySegmentsText(note.segments)).toBe("Access to /srv is not allowed");
  });

  it("tags new, renamed and linked folders", () => {
    expect(copyFolderTag(suggestion({}))?.text).toBe("new folder");
    expect(
      copyFolderTag(
        suggestion({
          status: "renamed",
          path: "/home/me/Code/ryco-2",
          takenPath: "/home/me/Code/ryco",
        }),
      ),
    ).toEqual({ text: "renamed, folder exists", tone: "warning" });
    expect(copyFolderTag(suggestion({ status: "link" }))?.text).toBe("existing checkout");
    expect(copyFolderTag(suggestion({ status: "blocked" }))).toBeNull();
  });

  it("sums the options up in one line", () => {
    const base = {
      mode: "clone" as const,
      changes: 2,
      commits: 1,
      ignoredFiles: 0,
      copySettings: true,
      setupCommand: "bun install --frozen-lockfile",
      followUp: false,
    };
    expect(copySegmentsText(copyOptionsSummary(base))).toBe(
      "+ 2 uncommitted changes · 1 unpushed commit · settings · runs bun install …",
    );
    // The command is marked for mono.
    expect(copyOptionsSummary(base).at(-1)).toEqual({ text: "bun install …", mono: true });
    expect(
      copySegmentsText(
        copyOptionsSummary({
          ...base,
          changes: 1,
          commits: 0,
          ignoredFiles: 1,
          setupCommand: null,
          followUp: true,
        }),
      ),
    ).toBe("+ 1 uncommitted change · 1 ignored file · settings · an agent finishes setup");
    // A link carries no work; nothing at all says so.
    expect(
      copySegmentsText(copyOptionsSummary({ ...base, mode: "link", setupCommand: null })),
    ).toBe("+ settings");
    expect(
      copySegmentsText(
        copyOptionsSummary({
          ...base,
          changes: 0,
          commits: 0,
          copySettings: false,
          setupCommand: "  ",
        }),
      ),
    ).toBe("Nothing extra");
  });

  it("shortens a long setup command to its first words", () => {
    expect(shortSetupCommand("bun install")).toBe("bun install");
    expect(shortSetupCommand("pnpm i\npnpm build")).toBe("pnpm i");
    expect(shortSetupCommand("bun install --frozen-lockfile")).toBe("bun install …");
    expect(shortSetupCommand("./scripts/a-very-long-setup-script-name.sh --flag")).toBe(
      "./scripts/a-very-long-s…",
    );
  });

  it("finds a path's parent on any node", () => {
    expect(parentOfNodePath("/home/me/Code/ryco")).toBe("/home/me/Code");
    expect(parentOfNodePath("/ryco")).toBe("/");
    expect(parentOfNodePath("C:\\Code\\ryco")).toBe("C:\\Code");
    expect(parentOfNodePath("C:\\ryco")).toBe("C:\\");
  });
});

describe("the connection cap (A22)", () => {
  it("refuses a copy that needs more Hub connections than the client keeps", () => {
    const relayed = (environmentId: EnvironmentId) => ({ environmentId, relayed: true });
    expect(
      copyConnectionCapReason({
        copyNodes: [relayed(MINI), relayed(HETZNER)],
        heldByRunningCopies: [relayed(GAMING)],
        maxConnections: 3,
      }),
    ).toBeNull();
    expect(
      copyConnectionCapReason({
        copyNodes: [relayed(MINI), relayed(HETZNER)],
        heldByRunningCopies: [relayed(GAMING), relayed(OLD)],
        maxConnections: 3,
      }),
    ).toBe("All connections are in use; let a running copy finish first.");
    // Direct nodes and nodes shared with the running copy take no extra slot.
    expect(
      copyConnectionCapReason({
        copyNodes: [{ environmentId: LAPTOP, relayed: false }, relayed(HETZNER)],
        heldByRunningCopies: [relayed(HETZNER), relayed(GAMING), relayed(OLD)],
        maxConnections: 3,
      }),
    ).toBeNull();
  });

  it("counts a running copy's nodes until its import started", () => {
    const record = createProjectCopyJobRecord({
      copyId: "copy-1",
      at: 1,
      sourceEnvironmentId: LAPTOP,
      sourceProjectId: SOURCE,
      targetEnvironmentId: HETZNER,
      projectId: NEW,
      importId: ProjectImportId.make(crypto.randomUUID()),
    });
    const entry = { running: true, record, progress: progress({ phase: "upload" }) };
    expect(nodesHeldByCopy(entry)).toEqual([HETZNER, LAPTOP]);
    expect(
      nodesHeldByCopy({ ...entry, progress: progress({ phase: "import", canCloseClient: true }) }),
    ).toEqual([]);
    expect(nodesHeldByCopy({ ...entry, running: false })).toEqual([]);
  });
});

function progress(patch: Partial<ProjectCopyProgress> = {}): ProjectCopyProgress {
  return {
    copyId: "copy-1",
    phase: "acquire",
    uploadedBytes: 0,
    totalBytes: 0,
    importSnapshot: null,
    canCloseClient: false,
    error: null,
    ...patch,
  };
}

function snapshot(patch: Partial<ProjectImportSnapshot> = {}): ProjectImportSnapshot {
  return {
    importId: ProjectImportId.make(crypto.randomUUID()),
    projectId: NEW,
    title: "ryco",
    destinationPath: "/home/me/Code/ryco",
    status: "running",
    steps: [],
    outputTail: "",
    error: null,
    warnings: [],
    preflight: null,
    leftoverPath: null,
    followUpThreadId: null,
    origin: { kind: "user", sourceLabel: null, proposalId: null },
    createdAt: "2026-10-22T12:00:00.000Z",
    updatedAt: "2026-10-22T12:00:00.000Z",
    ...patch,
  } as ProjectImportSnapshot;
}

const CONTEXT: CopyProgressContext = {
  sourceLabel: "MacBook Pro",
  targetLabel: "hetzner-build",
  mode: "clone",
  remoteUrl: "git@github.com:sak0a/ryco.git",
  branch: "task/copy-clone",
  destinationPath: "/home/me/Code/ryco",
  targetHome: "/home/me",
  changeCount: 2,
  setupCommand: "bun install --frozen-lockfile",
  uploads: true,
  bringsCommits: false,
  bringsChanges: true,
  copiesSettings: true,
  followUp: false,
};

const view = (steps: ReturnType<typeof copyProgressSteps>) =>
  steps.map((step) => `${step.status}:${copySegmentsText(step.label)}`);

describe("the progress list", () => {
  it("plans the target's steps before it reports any", () => {
    expect(view(copyProgressSteps(progress(), CONTEXT))).toEqual([
      "running:Connect to hetzner-build",
      "pending:Prepare the files on MacBook Pro",
      "pending:Send local work from MacBook Pro",
      "pending:Create ~/Code/ryco",
      "pending:Clone github.com/sak0a/ryco",
      "pending:Check out task/copy-clone",
      "pending:Apply 2 uncommitted changes",
      "pending:Add the project on hetzner-build",
      "pending:Copy project settings",
      "pending:Run bun install --frozen-lockfile",
    ]);
  });

  it("measures the upload and keeps its place while reconnecting", () => {
    const uploading = copyProgressSteps(
      progress({ phase: "upload", uploadedBytes: 1024 * 1024, totalBytes: 4 * 1024 * 1024 }),
      CONTEXT,
    );
    expect(uploading[2]).toMatchObject({ status: "running", percent: 25, log: "1.0 of 4.0 MB" });
    const reconnecting = copyProgressSteps(
      progress({ phase: "acquire", uploadedBytes: 1024 * 1024, totalBytes: 4 * 1024 * 1024 }),
      CONTEXT,
    );
    expect(reconnecting[0]?.status).toBe("done");
    expect(reconnecting[2]).toMatchObject({
      status: "running",
      log: "Reconnecting to hetzner-build…",
    });
  });

  it("marks where a failure before the import stopped", () => {
    const steps = copyProgressSteps(
      progress({
        phase: "failed",
        error: { code: "export-failed", message: "The bundle failed.", retry: null },
      }),
      CONTEXT,
    );
    expect(view(steps).slice(0, 3)).toEqual([
      "done:Connect to hetzner-build",
      "failed:Prepare the files on MacBook Pro",
      "pending:Send local work from MacBook Pro",
    ]);
    expect(steps[1]?.log).toBe("The bundle failed.");
  });

  it("follows the target's steps, without the skipped ones", () => {
    const steps = copyProgressSteps(
      progress({
        phase: "import",
        canCloseClient: true,
        importSnapshot: snapshot({
          outputTail: "Resolving 1,912 packages…\nLinking node_modules…\n",
          steps: [
            { id: "preflight", status: "done", progressPercent: null, detail: null },
            { id: "clone", status: "done", progressPercent: null, detail: null },
            { id: "lfs", status: "skipped", progressPercent: null, detail: "No Git LFS files" },
            { id: "setup", status: "running", progressPercent: null, detail: null },
          ],
        }),
      }),
      CONTEXT,
    );
    expect(view(steps)).toEqual([
      "done:Connect to hetzner-build",
      "done:Prepare the files on MacBook Pro",
      "done:Send local work from MacBook Pro",
      "done:Create ~/Code/ryco",
      "done:Clone github.com/sak0a/ryco",
      "running:Run bun install --frozen-lockfile",
    ]);
    expect(steps.at(-1)?.log).toBe("Linking node_modules…");
  });

  it("adds the running step's own percent to the overall bar", () => {
    const steps = copyProgressSteps(
      progress({
        phase: "import",
        canCloseClient: true,
        importSnapshot: snapshot({
          steps: [
            { id: "preflight", status: "done", progressPercent: null, detail: null },
            {
              id: "clone",
              status: "running",
              progressPercent: 50,
              detail: "Receiving objects 50%",
            },
          ],
        }),
      }),
      { ...CONTEXT, uploads: false },
    );
    // connect 6 + preflight 4 done, clone 32 at half: 26 of 42.
    expect(copyOverallPercent(steps, progress({ phase: "import" }))).toBe(62);
    expect(copyOverallPercent(steps, progress({ phase: "done" }))).toBe(100);
  });

  it("says whether Ryco must stay open (A22)", () => {
    expect(
      copyProgressFooter(
        progress({ phase: "upload", uploadedBytes: 2 * 1024 * 1024, totalBytes: 38 * 1024 * 1024 }),
        "D",
      ),
    ).toBe("Keep Ryco open until the upload finishes (2.0 of 38 MB).");
    // With the upload's speed known, how long is left.
    expect(
      copyProgressFooter(
        progress({ phase: "upload", uploadedBytes: 2 * 1024 * 1024, totalBytes: 38 * 1024 * 1024 }),
        "D",
        { bytesPerSecond: 3 * 1024 * 1024, secondsLeft: 12 },
      ),
    ).toBe("Keep Ryco open until the upload finishes (12 s left).");
    expect(copyProgressFooter(progress({ phase: "acquire" }), "D")).toBe(
      "Keep Ryco open until D starts the copy.",
    );
    expect(copyProgressFooter(progress({ phase: "import", canCloseClient: true }), "D")).toBe(
      "Runs on D; you can close Ryco.",
    );
  });
});

describe("the Copies block", () => {
  const baseRecord = createProjectCopyJobRecord({
    copyId: "copy-1",
    at: 1,
    sourceEnvironmentId: LAPTOP,
    sourceProjectId: SOURCE,
    targetEnvironmentId: HETZNER,
    projectId: NEW,
    importId: ProjectImportId.make(crypto.randomUUID()),
  });
  const rows = (input: Partial<Parameters<typeof projectCopyRows>[0]>) =>
    projectCopyRows({
      entries: [],
      records: [],
      imports: [],
      memberProjectIds: new Set([SOURCE]),
      projectNames: new Set(["ryco"]),
      labelOf: (environmentId) => (environmentId === HETZNER ? "hetzner-build" : "Device"),
      isResumable: (record) => record.stage === "import-requested" || record.stage === "importing",
      ...input,
    });

  it("shows this session's running and failed copies with their retry", () => {
    const running: ProjectCopyEntryLike = {
      copyId: "copy-1",
      title: "ryco",
      sourceLabel: "MacBook Pro",
      targetLabel: "hetzner-build",
      targetEnvironmentId: HETZNER,
      progress: progress({ phase: "upload", uploadedBytes: 1, totalBytes: 4 }),
      record: baseRecord,
      running: true,
      hasPlan: true,
    };
    const failed: ProjectCopyEntryLike = {
      ...running,
      copyId: "copy-2",
      record: { ...baseRecord, copyId: "copy-2" },
      running: false,
      progress: progress({
        phase: "failed",
        error: {
          code: "remote-unreachable",
          message: "Can't reach github.com",
          retry: "send-files",
        },
      }),
    };
    expect(
      rows({ entries: [running, failed] }).map((row) => [
        row.status,
        row.retryLabel,
        row.canDismiss,
      ]),
    ).toEqual([
      ["running", null, false],
      ["failed", "Send files instead", true],
    ]);
  });

  it("merges a stored record with what its node reports, and offers the leftover", () => {
    const record = reduceProjectCopyJobRecord(baseRecord, {
      type: "finished",
      outcome: "failed",
      at: 2,
    });
    const reported = snapshot({
      importId: record.importId,
      status: "interrupted",
      leftoverPath: "/home/me/Code/.ryco.ryco-import-x",
      error: { step: "clone", code: "interrupted", message: "hetzner-build restarted." },
    });
    const [row] = rows({
      records: [record],
      imports: [{ environmentId: HETZNER, snapshot: reported }],
    });
    expect(row).toMatchObject({
      status: "interrupted",
      description: "hetzner-build restarted.",
      leftover: { environmentId: HETZNER, importId: record.importId },
      canResume: false,
      canDismiss: true,
    });
  });

  it("lists a node's own import of this project that no record knows", () => {
    const other = snapshot({
      projectId: ProjectId.make("project-elsewhere"),
      status: "failed",
      leftoverPath: "/home/me/Code/.ryco.ryco-import-y",
      error: { step: "clone", code: "clone-failed", message: "Clone failed." },
    });
    const unrelated = snapshot({ title: "dotfiles", status: "failed" });
    const result = rows({
      imports: [
        { environmentId: HETZNER, snapshot: other },
        { environmentId: HETZNER, snapshot: unrelated },
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ status: "failed", copyId: null, canDismiss: false });
  });

  it("leaves out completed copies", () => {
    const record = reduceProjectCopyJobRecord(baseRecord, {
      type: "finished",
      outcome: "completed",
      at: 2,
    });
    expect(
      rows({
        records: [record],
        imports: [{ environmentId: HETZNER, snapshot: snapshot({ status: "completed" }) }],
      }),
    ).toEqual([]);
  });
});
