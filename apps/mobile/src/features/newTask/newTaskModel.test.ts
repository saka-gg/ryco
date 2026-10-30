import { describe, expect, it } from "vite-plus/test";

import type { Project, SidebarWorktreeSummary } from "@ryco/client-runtime/state/threads";
import {
  DEFAULT_MODEL,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorktreeId,
} from "@ryco/contracts";
import { createQuoteCitation, serializeQuoteCitation } from "@ryco/shared/quoteCitations";

import {
  canQueueNewTaskFor,
  deriveNewTaskDefaults,
  inferTaskTitle,
  newTaskContextLabel,
  resolveNewTaskProjectChoice,
} from "./newTaskModel";

const readyEnvironment = {
  environmentId: EnvironmentId.make("ready"),
  label: "Studio",
  connectionState: "connected" as const,
};
const readOnlyEnvironment = {
  environmentId: EnvironmentId.make("viewer"),
  label: "Shared",
  connectionState: "read-only" as const,
};
const project = {
  environmentId: readyEnvironment.environmentId,
  id: ProjectId.make("project"),
  name: "Ryco",
  cwd: "/code/ryco",
  defaultModelSelection: null,
  scripts: [],
} as Project;
const worktree = {
  environmentId: readyEnvironment.environmentId,
  projectId: project.id,
  id: WorktreeId.make("worktree"),
  title: "Mobile",
  branch: "feat/mobile",
  archivedAt: null,
} as SidebarWorktreeSummary;

describe("queueing a New Task for an away machine", () => {
  const offline = {
    environmentId: EnvironmentId.make("offline"),
    label: "Laptop",
    connectionState: "offline" as const,
  };

  it("waits only for a machine that is away and that this device may write to", () => {
    expect(canQueueNewTaskFor(offline)).toBe(true);
    expect(canQueueNewTaskFor({ ...offline, connectionState: "reconnecting" })).toBe(true);
    expect(canQueueNewTaskFor({ ...offline, role: "viewer" })).toBe(false);
    expect(canQueueNewTaskFor(readyEnvironment)).toBe(false);
    expect(canQueueNewTaskFor(readOnlyEnvironment)).toBe(false);
  });

  it("prefers a live machine and falls back to the away one it was opened for", () => {
    const awayProject = { ...project, environmentId: offline.environmentId } as Project;
    expect(
      deriveNewTaskDefaults({
        launch: { environmentId: offline.environmentId },
        environments: [offline, readyEnvironment],
        projects: [project, awayProject],
        worktrees: [],
      }).environment?.environmentId,
    ).toBe(readyEnvironment.environmentId);
    const defaults = deriveNewTaskDefaults({
      launch: { environmentId: offline.environmentId },
      environments: [readOnlyEnvironment, offline],
      projects: [awayProject],
      worktrees: [],
    });
    expect(defaults.environment?.environmentId).toBe(offline.environmentId);
    expect(defaults.project?.environmentId).toBe(offline.environmentId);
    expect(
      resolveNewTaskProjectChoice({
        target: { environmentId: offline.environmentId, projectId: project.id },
        projects: [awayProject],
        environments: [offline],
      })?.environmentId,
    ).toBe(offline.environmentId);
  });
});

describe("New Task defaults", () => {
  it("falls back from a read-only launch node to the first mutation-ready node", () => {
    const defaults = deriveNewTaskDefaults({
      launch: { environmentId: readOnlyEnvironment.environmentId },
      environments: [readOnlyEnvironment, readyEnvironment],
      projects: [project],
      worktrees: [worktree],
    });

    expect(defaults.environment?.environmentId).toBe(readyEnvironment.environmentId);
    expect(defaults.project?.id).toBe(project.id);
    expect(defaults.worktree).toBeNull();
    expect(defaults.modelSelection).toMatchObject({
      instanceId: "codex",
      model: "gpt-5.6-terra",
    });
    expect(defaults.tokenMode).toBe("off");
  });

  it("ignores a model stored by older versions on the selected project", () => {
    const defaults = deriveNewTaskDefaults({
      environments: [readyEnvironment],
      projects: [
        {
          ...project,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("legacy-provider"),
            model: "legacy-project-model",
          },
        },
      ],
      worktrees: [],
    });
    expect(defaults.project?.id).toBe(project.id);
    expect(defaults.modelSelection).toEqual({ instanceId: "codex", model: DEFAULT_MODEL });
  });

  it("preserves an active launched project and worktree", () => {
    const defaults = deriveNewTaskDefaults({
      launch: {
        environmentId: readyEnvironment.environmentId,
        projectId: project.id,
        worktreeId: worktree.id,
      },
      environments: [readyEnvironment],
      projects: [project],
      worktrees: [worktree],
    });
    expect(defaults.project?.id).toBe(project.id);
    expect(defaults.worktree?.id).toBe(worktree.id);
  });

  it("marks the inline project prerequisite without selecting stale context", () => {
    const defaults = deriveNewTaskDefaults({
      environments: [readyEnvironment],
      projects: [],
      worktrees: [],
    });
    expect(defaults.requiresProject).toBe(true);
    expect(defaults.project).toBeNull();
  });

  it("formats compact context and bounded task titles", () => {
    expect(
      newTaskContextLabel({
        environmentLabel: "Studio",
        projectTitle: "Ryco",
        worktreeTitle: "Mobile",
      }),
    ).toBe("Studio · Ryco · Mobile");
    expect(inferTaskTitle(`  ${"a".repeat(90)}\nsecond line`)).toHaveLength(70);
    expect(inferTaskTitle("")).toBe("New task");
    const token = serializeQuoteCitation(
      createQuoteCitation({
        source: { environmentId: EnvironmentId.make("ready"), threadId: ThreadId.make("thread") },
        messageId: MessageId.make("message"),
        selector: { exact: "The passage.", prefix: "", suffix: "", start: 0, end: 12 },
      }),
    );
    expect(inferTaskTitle(`Explain ${token}`)).toBe("Explain “The passage.”");
  });
});

describe("Project picker machine selection", () => {
  it("uses the selected machine even when another machine has the same project id", () => {
    const secondEnvironment = {
      ...readyEnvironment,
      environmentId: EnvironmentId.make("second"),
      label: "Laptop",
    };
    const secondProject = {
      ...project,
      environmentId: secondEnvironment.environmentId,
      cwd: "/laptop/ryco",
    };
    const input = {
      target: { environmentId: secondEnvironment.environmentId, projectId: project.id },
      environments: [readyEnvironment, secondEnvironment],
      projects: [project, secondProject],
    };
    expect(resolveNewTaskProjectChoice(input)).toBe(secondProject);
    expect(resolveNewTaskProjectChoice({ ...input, projects: [project] })).toBeNull();
    expect(
      resolveNewTaskProjectChoice({
        ...input,
        environments: [readyEnvironment, { ...secondEnvironment, connectionState: "read-only" }],
      }),
    ).toBeNull();
  });
});
