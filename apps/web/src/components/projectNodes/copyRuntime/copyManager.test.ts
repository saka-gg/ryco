import {
  createProjectCopyJobRecord,
  reduceProjectCopyJobRecord,
  type ProjectCopyJobRecord,
  type ProjectCopyOutcome,
  type ProjectCopyProgress,
  type ProjectCopyRunPlan,
  type StartProjectCopyInput,
} from "@ryco/client-runtime/projectCopy";
import {
  EnvironmentId,
  ProjectId,
  type AgentControlClientExecutorId,
  type AgentControlProposalId,
  type AgentControlReportClientExecutionInput,
  type EnvironmentApi,
} from "@ryco/contracts";
import { ProjectImportId, type ProjectImportSnapshot } from "@ryco/contracts/project-copy";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const toasts = vi.hoisted(() => ({
  showProjectCopyProgressToast: vi.fn(),
  showProjectCopyResultToast: vi.fn(),
  dismissProjectCopyToast: vi.fn(),
}));
vi.mock("./projectCopyToasts", () => toasts);

const MINI = "env-mini";
const LAPTOP = "env-laptop";
vi.mock("../../../environments/nodeCatalog", () => ({
  readNodeCatalogSnapshot: () => ({
    nodes: [
      { environmentId: "env-mini", label: "Mac mini" },
      { environmentId: "env-laptop", label: "Laptop" },
    ],
    ownerEnvironmentIds: new Set(),
  }),
  subscribeNodeCatalog: () => () => undefined,
}));

import { getLocalStorageItem, setLocalStorageItem } from "../../../hooks/useLocalStorage";
import {
  PROJECT_COPY_RECORDS_STORAGE_KEY,
  resetProjectNodesDialogStoreForTests,
  useProjectNodesDialogStore,
} from "../projectNodesDialogStore";
import {
  cancelProjectCopy,
  registerProjectCopyViewer,
  resetProjectCopyManagerForTests,
  resumeProjectCopies,
  resumeProjectCopy,
  retryProjectCopy,
  runProjectCopyInBackground,
  setProjectCopyRuntimeForTests,
  showProjectCopyProgress,
  startManagedProjectCopy,
  trackProjectImport,
  useProjectCopyStore,
  viewCopiedProject,
  type ProjectCopyRuntime,
} from "./copyManager";
import type { WebProjectCopyIo } from "./webProjectCopyIo";

const target = EnvironmentId.make(MINI);
const source = EnvironmentId.make(LAPTOP);
const newProjectId = ProjectId.make("project-new");

const plan = {
  title: "ryco",
  source: {
    kind: "export",
    environmentId: source,
    label: "Laptop",
    projectId: ProjectId.make("project-source"),
    checkoutPath: null,
  },
  target: { environmentId: target, label: "Mac mini", pathSeparator: "/" },
  destinationPath: "/Users/me/Code/ryco",
  choices: {
    mode: "clone",
    bringCommits: false,
    bringChanges: false,
    ignoredPaths: [],
    copySettings: true,
    copyAvatar: false,
  },
  sendFilesFallback: true,
} as unknown as ProjectCopyRunPlan;

function record(overrides: Partial<ProjectCopyJobRecord> = {}): ProjectCopyJobRecord {
  return {
    ...createProjectCopyJobRecord({
      copyId: "copy-1",
      at: 1_000,
      sourceEnvironmentId: source,
      sourceProjectId: ProjectId.make("project-source"),
      targetEnvironmentId: target,
      projectId: newProjectId,
      importId: ProjectImportId.make(crypto.randomUUID()),
    }),
    ...overrides,
  };
}

function progress(copyId: string, patch: Partial<ProjectCopyProgress> = {}): ProjectCopyProgress {
  return {
    copyId,
    phase: "acquire",
    uploadedBytes: 0,
    totalBytes: 0,
    importSnapshot: null,
    canCloseClient: false,
    error: null,
    ...patch,
  };
}

const snapshot = (status: ProjectImportSnapshot["status"]) =>
  ({
    title: "ryco",
    status,
    destinationPath: "/Users/me/Code/ryco",
    steps: [],
    warnings: [],
  }) as unknown as ProjectImportSnapshot;

/** A coordinator stand-in: reports like the real one and settles when told to. */
interface FakeRun {
  readonly input: StartProjectCopyInput;
  readonly cancel: ReturnType<typeof vi.fn<() => void>>;
  record: ProjectCopyJobRecord;
  progress: ProjectCopyProgress;
  emitRecord(next: ProjectCopyJobRecord): void;
  emitProgress(patch: Partial<ProjectCopyProgress>): void;
  settle(outcome: Partial<ProjectCopyOutcome>): void;
}

function fakeRuntime() {
  const runs: FakeRun[] = [];
  const reports: AgentControlReportClientExecutionInput[] = [];
  const disposed = vi.fn();
  const runtime: ProjectCopyRuntime = {
    startProjectCopy: (input) => {
      let settle: (outcome: ProjectCopyOutcome) => void = () => undefined;
      const done = new Promise<ProjectCopyOutcome>((resolve) => {
        settle = resolve;
      });
      const initial =
        input.resume ??
        (input.restartOf
          ? reduceProjectCopyJobRecord(input.restartOf, {
              type: "restarted",
              at: 2_000,
              importId: ProjectImportId.make(crypto.randomUUID()),
              projectId: newProjectId,
            })
          : record({ agentControl: input.agentControl ?? null }));
      const run: FakeRun = {
        input,
        cancel: vi.fn<() => void>(),
        record: initial,
        progress: progress(initial.copyId),
        emitRecord: (next) => {
          run.record = next;
          input.onRecord?.(next);
        },
        emitProgress: (patch) => {
          run.progress = { ...run.progress, ...patch };
          input.onProgress?.(run.progress);
        },
        settle: (outcome) =>
          settle({ progress: run.progress, record: run.record, project: null, ...outcome }),
      };
      runs.push(run);
      input.onRecord?.(initial);
      input.onProgress?.(run.progress);
      return {
        copyId: initial.copyId,
        getProgress: () => run.progress,
        done,
        cancel: run.cancel,
        detach: vi.fn<() => void>(),
      };
    },
    projectCopyPlanWithSendFiles: (current) => ({ ...current, title: `${current.title} (files)` }),
    createIo: () => ({ dispose: disposed }) as unknown as WebProjectCopyIo,
    callNodeWithLease: async (_environmentId, call) =>
      call({
        agentControl: {
          reportClientExecution: async (input: AgentControlReportClientExecutionInput) => {
            reports.push(input);
            return {};
          },
        },
      } as unknown as EnvironmentApi) as never,
  };
  return { runtime, runs, reports, disposed };
}

const storedRecords = () =>
  getLocalStorageItem(PROJECT_COPY_RECORDS_STORAGE_KEY, Schema.Unknown) as ReadonlyArray<{
    copyId: string;
    stage: string;
  }> | null;

const agentControl = {
  environmentId: source,
  proposalId: "proposal-1" as AgentControlProposalId,
  executorId: "c0a8f3d2-4b1e-4f6a-9d2c-7e5b3a1f0c9d" as AgentControlClientExecutorId,
};

let fake: ReturnType<typeof fakeRuntime>;

beforeEach(() => {
  fake = fakeRuntime();
  setProjectCopyRuntimeForTests(fake.runtime);
});

afterEach(() => {
  resetProjectCopyManagerForTests();
  resetProjectNodesDialogStoreForTests();
  setProjectCopyRuntimeForTests(null);
  setLocalStorageItem(PROJECT_COPY_RECORDS_STORAGE_KEY, [], Schema.Unknown);
  vi.clearAllMocks();
});

describe("copyManager", () => {
  it("badges the copied checkout's sidebar row while the copy runs outside the dialog", async () => {
    const copy = await startManagedProjectCopy({ plan, toast: false });
    const sourceKey = `${source}:project-source`;
    // The dialog shows it: no badge yet.
    expect(useProjectNodesDialogStore.getState().copyBadges).toEqual({});

    showProjectCopyProgress(copy.copyId);
    expect(useProjectNodesDialogStore.getState().copyBadges).toEqual({ [sourceKey]: null });
    fake.runs[0]!.emitProgress({ phase: "upload", uploadedBytes: 3, totalBytes: 10 });
    expect(useProjectNodesDialogStore.getState().copyBadges).toEqual({ [sourceKey]: 30 });

    fake.runs[0]!.settle({ progress: progress(copy.copyId, { phase: "done" }) });
    await copy.done;
    expect(useProjectNodesDialogStore.getState().copyBadges).toEqual({});
  });

  it("follows an import the add-project dialog handed over, worded as a clone", async () => {
    const importId = ProjectImportId.make(crypto.randomUUID());
    const copy = await trackProjectImport({
      environmentId: target,
      importId,
      projectId: newProjectId,
      title: "codex",
      action: "clone",
    });

    const run = fake.runs[0]!;
    // Only following: no plan, the record says the node accepted the import.
    expect(run.input.plan).toBeNull();
    expect(run.input.resume).toMatchObject({
      targetEnvironmentId: target,
      importId,
      projectId: newProjectId,
      sourceEnvironmentId: null,
      stage: "importing",
    });
    expect(useProjectCopyStore.getState().entries[copy.copyId]).toMatchObject({
      title: "codex",
      action: "clone",
      background: false,
      sourceRef: null,
    });
    expect(storedRecords()).toEqual([
      expect.objectContaining({ copyId: copy.copyId, stage: "importing" }),
    ]);
    expect(toasts.showProjectCopyProgressToast).toHaveBeenCalledWith(
      copy.copyId,
      expect.objectContaining({ title: "Cloning codex to Mac mini" }),
      expect.anything(),
    );
  });

  it("starts a copy, keeps its progress in the store and persists its record", async () => {
    const copy = await startManagedProjectCopy({ plan });

    expect(copy.copyId).toBe("copy-1");
    expect(fake.runs[0]?.input.plan).toBe(plan);
    expect(useProjectCopyStore.getState().entries["copy-1"]).toMatchObject({
      title: "ryco",
      sourceLabel: "Laptop",
      targetLabel: "Mac mini",
      targetEnvironmentId: target,
      running: true,
      background: false,
      hasPlan: true,
    });
    expect(useProjectNodesDialogStore.getState().copiesActive).toBe(true);
    expect(storedRecords()).toEqual([
      expect.objectContaining({ copyId: "copy-1", stage: "export" }),
    ]);
    expect(toasts.showProjectCopyProgressToast).toHaveBeenCalledWith(
      "copy-1",
      expect.objectContaining({ kind: "progress", title: "Copying ryco to Mac mini" }),
      expect.anything(),
    );

    const run = fake.runs[0]!;
    run.emitRecord(reduceProjectCopyJobRecord(run.record, { type: "import-requested", at: 3_000 }));
    run.emitProgress({ phase: "upload", uploadedBytes: 5, totalBytes: 10 });
    expect(useProjectCopyStore.getState().entries["copy-1"]?.progress.phase).toBe("upload");
    expect(storedRecords()).toEqual([
      expect.objectContaining({ copyId: "copy-1", stage: "import-requested" }),
    ]);
    expect(toasts.showProjectCopyProgressToast).toHaveBeenLastCalledWith(
      "copy-1",
      expect.objectContaining({ percent: 50 }),
      expect.anything(),
    );
  });

  it("ends with the result toast and lets View open a draft in the new project", async () => {
    const opened: unknown[] = [];
    registerProjectCopyViewer((projectRef) => {
      opened.push(projectRef);
    });
    const copy = await startManagedProjectCopy({ plan });
    const run = fake.runs[0]!;
    run.emitProgress({ phase: "done", importSnapshot: snapshot("completed") });
    run.emitRecord(
      reduceProjectCopyJobRecord(run.record, { type: "finished", outcome: "completed", at: 4_000 }),
    );
    run.settle({
      project: {
        environmentId: target,
        projectId: newProjectId,
        workspaceRoot: "/Users/me/Code/ryco",
        warnings: [],
      },
    });
    await copy.done;

    const entry = useProjectCopyStore.getState().entries["copy-1"];
    expect(entry).toMatchObject({ running: false, project: { projectId: newProjectId } });
    expect(fake.disposed).toHaveBeenCalled();
    expect(toasts.showProjectCopyResultToast).toHaveBeenCalledWith(
      "copy-1",
      expect.objectContaining({ kind: "done", title: "ryco is ready on Mac mini" }),
      expect.objectContaining({ onView: expect.any(Function) }),
    );

    await viewCopiedProject("copy-1");
    expect(opened).toEqual([{ environmentId: target, projectId: newProjectId }]);
  });

  it("leaves a copy the dialog shows to the dialog, then hands a running one to its toast", async () => {
    const copy = await startManagedProjectCopy({ plan, toast: false });
    const run = fake.runs[0]!;
    expect(useProjectCopyStore.getState().entries["copy-1"]).toMatchObject({
      background: true,
      inDialog: true,
    });
    run.emitProgress({ phase: "upload", uploadedBytes: 1, totalBytes: 2 });
    expect(toasts.showProjectCopyProgressToast).not.toHaveBeenCalled();

    // The dialog closed while it runs: the toast takes over.
    showProjectCopyProgress("copy-1");
    expect(useProjectCopyStore.getState().entries["copy-1"]).toMatchObject({
      background: false,
      inDialog: false,
    });
    expect(toasts.showProjectCopyProgressToast).toHaveBeenCalledTimes(1);
    run.emitProgress({ phase: "done", importSnapshot: snapshot("completed") });
    run.settle({});
    await copy.done;
    expect(toasts.showProjectCopyResultToast).toHaveBeenCalledTimes(1);
  });

  it("does not toast how a copy ended while the dialog shows it", async () => {
    const copy = await startManagedProjectCopy({ plan, toast: false });
    const run = fake.runs[0]!;
    run.emitProgress({ phase: "done", importSnapshot: snapshot("completed") });
    run.settle({});
    await copy.done;
    expect(toasts.showProjectCopyResultToast).not.toHaveBeenCalled();
    // Closing the dialog afterwards toasts nothing either.
    showProjectCopyProgress("copy-1");
    expect(toasts.showProjectCopyProgressToast).not.toHaveBeenCalled();
    expect(toasts.showProjectCopyResultToast).not.toHaveBeenCalled();
  });

  it("keeps a copy running in the background without its progress toast", async () => {
    await startManagedProjectCopy({ plan });
    runProjectCopyInBackground("copy-1");
    toasts.showProjectCopyProgressToast.mockClear();
    fake.runs[0]!.emitProgress({ phase: "export" });

    expect(useProjectCopyStore.getState().entries["copy-1"]?.background).toBe(true);
    expect(toasts.dismissProjectCopyToast).toHaveBeenCalledWith("copy-1");
    expect(toasts.showProjectCopyProgressToast).not.toHaveBeenCalled();

    cancelProjectCopy("copy-1");
    expect(fake.runs[0]!.cancel).toHaveBeenCalled();
  });

  it("retries a failed clone by sending the files, under the same copy", async () => {
    const copy = await startManagedProjectCopy({ plan });
    const run = fake.runs[0]!;
    run.emitProgress({
      phase: "failed",
      error: { code: "remote-unreachable", message: "Can't reach origin.", retry: "send-files" },
    });
    run.emitRecord(
      reduceProjectCopyJobRecord(run.record, { type: "finished", outcome: "failed", at: 4_000 }),
    );
    run.settle({});
    await copy.done;
    expect(toasts.showProjectCopyResultToast).toHaveBeenCalledWith(
      "copy-1",
      expect.objectContaining({ kind: "failed", retryLabel: "Send files instead" }),
      expect.objectContaining({ onRetry: expect.any(Function) }),
    );

    const retried = await retryProjectCopy("copy-1");
    expect(retried?.copyId).toBe("copy-1");
    const restart = fake.runs[1]!.input;
    expect(restart.plan?.title).toBe("ryco (files)");
    expect(restart.restartOf?.copyId).toBe("copy-1");
    expect(useProjectCopyStore.getState().entries["copy-1"]?.running).toBe(true);
  });

  it("resumes unfinished records at app start without a plan, once", async () => {
    const now = Date.now();
    const importing = record({ copyId: "copy-importing", stage: "importing", updatedAt: now });
    const finished = record({
      copyId: "copy-finished",
      stage: "finished",
      outcome: "completed",
      updatedAt: now - 1,
    });
    setLocalStorageItem(PROJECT_COPY_RECORDS_STORAGE_KEY, [importing, finished], Schema.Unknown);

    await resumeProjectCopies();
    await resumeProjectCopies();

    expect(fake.runs).toHaveLength(1);
    expect(fake.runs[0]?.input).toMatchObject({ plan: null, resume: importing });
    expect(useProjectCopyStore.getState().entries["copy-importing"]).toMatchObject({
      title: null,
      sourceLabel: "Laptop",
      targetLabel: "Mac mini",
      background: true,
      hasPlan: false,
    });
    expect(useProjectCopyStore.getState().records.map((entry) => entry.copyId)).toEqual(
      expect.arrayContaining(["copy-importing", "copy-finished"]),
    );

    // A second resume of the same record while it runs does not start it twice.
    setLocalStorageItem(PROJECT_COPY_RECORDS_STORAGE_KEY, [importing], Schema.Unknown);
    await expect(resumeProjectCopy("copy-importing")).resolves.toBeNull();
    expect(fake.runs).toHaveLength(1);

    // The target's import names the project.
    fake.runs[0]!.emitProgress({ phase: "import", importSnapshot: snapshot("running") });
    expect(useProjectCopyStore.getState().entries["copy-importing"]?.title).toBe("ryco");
  });

  it("reports an Agent Control copy to the proposal's node: started, then completed", async () => {
    const copy = await startManagedProjectCopy({ plan, agentControl });
    const run = fake.runs[0]!;
    expect(run.input.agentControl).toEqual(agentControl);
    run.emitRecord(reduceProjectCopyJobRecord(run.record, { type: "import-accepted", at: 3_000 }));
    run.emitRecord(reduceProjectCopyJobRecord(run.record, { type: "import-accepted", at: 3_500 }));
    run.emitProgress({ phase: "done", importSnapshot: snapshot("completed") });
    run.settle({
      project: {
        environmentId: target,
        projectId: newProjectId,
        workspaceRoot: "/Users/me/Code/ryco",
        warnings: ["  ", "Setup exited with 1."],
      },
    });
    await copy.done;

    expect(fake.reports).toEqual([
      {
        proposalId: "proposal-1",
        executorId: agentControl.executorId,
        outcome: "started",
        importId: run.record.importId,
      },
      {
        proposalId: "proposal-1",
        executorId: agentControl.executorId,
        outcome: "completed",
        importId: run.record.importId,
        result: {
          targetEnvironmentId: target,
          projectId: newProjectId,
          workspaceRoot: "/Users/me/Code/ryco",
          warnings: ["Setup exited with 1."],
        },
      },
    ]);
  });

  it("ends an Agent Control copy for good when it fails, and reports why", async () => {
    const copy = await startManagedProjectCopy({ plan, agentControl });
    const run = fake.runs[0]!;
    // A resumable failure: the coordinator leaves the record unfinished.
    run.emitProgress({
      phase: "failed",
      error: { code: "node-unavailable", message: "Mac mini did not answer.", retry: "resume" },
    });
    run.settle({});
    const outcome = await copy.done;

    expect(outcome.record).toMatchObject({ stage: "finished", outcome: "failed" });
    expect(storedRecords()).toEqual([
      expect.objectContaining({ copyId: "copy-1", stage: "finished" }),
    ]);
    expect(fake.reports).toEqual([
      expect.objectContaining({ outcome: "failed", error: "Mac mini did not answer." }),
    ]);
    // Its toast offers no retry: the agent decides what happens next.
    expect(toasts.showProjectCopyResultToast).toHaveBeenCalledWith(
      "copy-1",
      expect.objectContaining({ kind: "failed" }),
      expect.objectContaining({ onRetry: undefined }),
    );
  });

  it("resumes an Agent Control upload with the plan rebuilt from its proposal", async () => {
    const now = Date.now();
    const rebuilt = { ...plan, title: "ryco (rebuilt)" } as ProjectCopyRunPlan;
    const rebuild = vi.fn(async (stored: ProjectCopyJobRecord) =>
      stored.copyId === "copy-upload" ? rebuilt : null,
    );
    setProjectCopyRuntimeForTests({ ...fake.runtime, rebuildAgentControlPlan: rebuild });
    const upload = record({ copyId: "copy-upload", stage: "upload", agentControl, updatedAt: now });
    // Its proposal no longer runs: no plan, so the copy cleans up and reports `failed`.
    const ended = record({ copyId: "copy-ended", stage: "export", agentControl, updatedAt: now });
    // An import that started is followed; it needs no plan.
    const importing = record({
      copyId: "copy-importing",
      stage: "importing",
      agentControl,
      updatedAt: now,
    });
    setLocalStorageItem(
      PROJECT_COPY_RECORDS_STORAGE_KEY,
      [upload, ended, importing],
      Schema.Unknown,
    );

    await resumeProjectCopies();

    expect(rebuild.mock.calls.map(([stored]) => stored.copyId).toSorted()).toEqual([
      "copy-ended",
      "copy-upload",
    ]);
    expect(rebuild).toHaveBeenCalledWith(upload, agentControl);
    const inputs = new Map(fake.runs.map((run) => [run.input.resume?.copyId, run.input]));
    expect(inputs.get("copy-upload")).toMatchObject({ plan: rebuilt, agentControl });
    expect(inputs.get("copy-ended")).toMatchObject({ plan: null, agentControl });
    expect(inputs.get("copy-importing")).toMatchObject({ plan: null, agentControl });
    expect(useProjectCopyStore.getState().entries["copy-upload"]).toMatchObject({
      title: "ryco (rebuilt)",
      hasPlan: true,
    });
  });
});
