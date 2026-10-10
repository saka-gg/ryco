import type { NodeMutationLease } from "@ryco/client-runtime/authorization";
import type { Project } from "@ryco/client-runtime/state/threads";
import { DraftId } from "@ryco/client-runtime/state/composer";
import { EnvironmentId, ProjectId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { createHostedDraftTargetController } from "./draftExecutionTarget";

const source = EnvironmentId.make("source");
const target = EnvironmentId.make("target");
const third = EnvironmentId.make("third");
const draftId = DraftId.make("unsent-draft");
function project(environmentId: EnvironmentId, name = "repo", id = name): Project {
  return {
    environmentId,
    id: ProjectId.make(id),
    name,
    cwd: `/projects/${id}`,
    defaultModelSelection: null,
    scripts: [],
  };
}
function lease(environmentId = target, generation = 1): NodeMutationLease {
  return {
    environmentId,
    selectionGeneration: generation,
    snapshotGeneration: generation,
    effectiveRole: "owner",
    directoryReady: true,
    relayReady: true,
    shellReady: true,
  };
}
function harness() {
  let routed = source;
  let sourceCurrent = true;
  let eligible = true;
  let readyLease: NodeMutationLease | null = lease();
  let projects = [project(target, "other")];
  let previewProjects = false;
  const waiters: Array<(value: NodeMutationLease | null) => void> = [];
  const routeListeners = new Set<() => void>();
  const release = vi.fn();
  const adopt = vi.fn((environmentId: EnvironmentId) => {
    routed = environmentId;
    return true;
  });
  const move = vi.fn();
  const moveToChat = vi.fn();
  const retry = vi.fn();
  const readLease = vi.fn(() => readyLease);
  const controller = createHostedDraftTargetController({
    sourceIsCurrent: () => sourceCurrent,
    targetIsEligible: () => eligible,
    routeMatches: (request) => routed === request.environmentId,
    subscribeRoute: (listener) => {
      routeListeners.add(listener);
      return () => routeListeners.delete(listener);
    },
    retain: () => release,
    adopt,
    waitForLease: () => new Promise((resolve) => waiters.push(resolve)),
    readLease,
    readProjects: () => projects,
    canPreviewProjects: () => previewProjects,
    move,
    moveToChat,
    retry,
  });
  const begin = (environmentId = target) =>
    controller.begin({
      draftId,
      project: project(source),
      environmentId,
      label: "Target",
      logicalKey: (value) => value.name,
    });
  return {
    controller,
    begin,
    move,
    moveToChat,
    release,
    adopt,
    retry,
    readLease,
    waiters,
    setProjects: (values: Project[]) => {
      projects = values;
    },
    setPreviewProjects: (value: boolean) => {
      previewProjects = value;
    },
    setLease: (value: NodeMutationLease | null) => {
      readyLease = value;
    },
    setEligible: (value: boolean) => {
      eligible = value;
    },
    setSourceCurrent: (value: boolean) => {
      sourceCurrent = value;
    },
    navigate: () => {
      routed = third;
      routeListeners.forEach((listener) => listener());
    },
  };
}
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("hosted draft device switching", () => {
  it("shows cached projects immediately but commits the choice only after a fresh lease", async () => {
    const test = harness();
    test.setPreviewProjects(true);
    test.setLease(null);
    test.begin();
    expect(test.controller.getSnapshot()?.phase).toBe("project");
    test.controller.selectProject(ProjectId.make("other"));
    expect(test.move).not.toHaveBeenCalled();
    expect(test.controller.getSnapshot()?.phase).toBe("connecting");
    test.setLease(lease());
    test.waiters[0]!(lease());
    await settle();
    expect(test.move).toHaveBeenCalledWith(draftId, project(target, "other"), "other");
  });

  it("does not commit a cached project removed from the fresh shell", async () => {
    const test = harness();
    test.setPreviewProjects(true);
    test.setLease(null);
    test.begin();
    test.controller.selectProject(ProjectId.make("other"));
    test.setProjects([]);
    test.setLease(lease());
    test.waiters[0]!(lease());
    await settle();
    expect(test.move).not.toHaveBeenCalled();
    expect(test.controller.getSnapshot()?.phase).toBe("error");
  });

  it("waits for a current shell before opening the target project picker", async () => {
    const test = harness();
    test.begin();
    expect(test.controller.getSnapshot()?.phase).toBe("connecting");
    expect(test.move).not.toHaveBeenCalled();
    test.waiters[0]!(lease());
    await settle();
    expect(test.controller.getSnapshot()?.phase).toBe("project");
    test.controller.selectProject(ProjectId.make("other"));
    expect(test.move).toHaveBeenCalledWith(draftId, project(target, "other"), "other");
    expect(test.controller.getSnapshot()).toBeNull();
    expect(test.release).toHaveBeenCalledOnce();
  });

  it("automatically chooses a unique logical match, but asks when ambiguous", async () => {
    const test = harness();
    test.setProjects([project(target)]);
    test.begin();
    test.waiters[0]!(lease());
    await settle();
    expect(test.move).toHaveBeenCalledWith(draftId, project(target), "repo");
    test.move.mockClear();
    test.setProjects([project(target, "repo", "one"), project(target, "repo", "two")]);
    test.begin();
    test.waiters[1]!(lease());
    await settle();
    expect(test.move).not.toHaveBeenCalled();
    expect(test.controller.getSnapshot()?.phase).toBe("project");
  });

  it("returns to the source on cancellation and ignores delayed readiness", async () => {
    const test = harness();
    test.setProjects([project(target)]);
    test.begin();
    test.controller.cancel();
    test.waiters[0]!(lease());
    await settle();
    expect(test.adopt).toHaveBeenLastCalledWith(source);
    expect(test.move).not.toHaveBeenCalled();
    expect(test.controller.getSnapshot()).toBeNull();
    expect(test.release).toHaveBeenCalledOnce();
  });

  it("ignores an earlier selection when another device is chosen", async () => {
    const test = harness();
    test.begin();
    test.begin(third);
    test.setProjects([project(third)]);
    test.setLease(lease(third));
    test.waiters[0]!(lease());
    await settle();
    expect(test.move).not.toHaveBeenCalled();
    expect(test.controller.getSnapshot()?.environmentId).toBe(third);
    test.waiters[1]!(lease(third));
    await settle();
    expect(test.move).toHaveBeenCalledWith(draftId, project(third), "repo");
  });

  it("releases pending demand on navigation without redirecting the user", async () => {
    const test = harness();
    test.begin();
    test.navigate();
    test.waiters[0]!(lease());
    await settle();
    expect(test.controller.getSnapshot()).toBeNull();
    expect(test.adopt).toHaveBeenCalledOnce();
    expect(test.release).toHaveBeenCalledOnce();
    expect(test.move).not.toHaveBeenCalled();
  });

  it.each(["lease", "role"])(
    "blocks project selection after %s readiness changes",
    async (change) => {
      const test = harness();
      test.begin();
      test.waiters[0]!(lease());
      await settle();
      if (change === "lease") test.setLease(null);
      else test.setEligible(false);
      test.controller.selectProject(ProjectId.make("other"));
      expect(test.move).not.toHaveBeenCalled();
      expect(test.controller.getSnapshot()?.phase).toBe("error");
    },
  );

  it("does not move a draft that was promoted or changed while connecting", async () => {
    const test = harness();
    test.begin();
    test.setSourceCurrent(false);
    test.waiters[0]!(lease());
    await settle();
    expect(test.move).not.toHaveBeenCalled();
    test.controller.cancel();
    expect(test.adopt).toHaveBeenCalledOnce();
  });

  it("rejects a lease generation change while reading target projects", async () => {
    const test = harness();
    test.begin();
    test.waiters[0]!(lease());
    await settle();
    test.readLease.mockReturnValueOnce(lease()).mockReturnValueOnce(lease(target, 2));
    test.controller.selectProject(ProjectId.make("other"));
    expect(test.move).not.toHaveBeenCalled();
    expect(test.controller.getSnapshot()?.phase).toBe("error");
  });

  it("retries without letting an earlier wait overwrite the new result", async () => {
    const test = harness();
    test.begin();
    test.controller.retry();
    test.waiters[1]!(lease());
    await settle();
    expect(test.controller.getSnapshot()?.phase).toBe("project");
    test.waiters[0]!(null);
    await settle();
    expect(test.controller.getSnapshot()?.phase).toBe("project");
    expect(test.retry).toHaveBeenCalledWith(target);
  });

  it("turns the draft into a chat on the target only under a current lease", async () => {
    const test = harness();
    test.setPreviewProjects(true);
    test.setLease(null);
    test.begin();
    test.controller.selectNoProject();
    expect(test.moveToChat).not.toHaveBeenCalled();
    expect(test.controller.getSnapshot()?.phase).toBe("connecting");
    test.setLease(lease());
    test.waiters[0]!(lease());
    await settle();
    expect(test.moveToChat).toHaveBeenCalledWith(draftId, target);
    expect(test.move).not.toHaveBeenCalled();
    expect(test.controller.getSnapshot()).toBeNull();
  });

  it("keeps the source draft after failure and allows a successful retry", async () => {
    const test = harness();
    test.begin();
    test.waiters[0]!(null);
    await settle();
    expect(test.controller.getSnapshot()?.phase).toBe("error");
    expect(test.move).not.toHaveBeenCalled();
    test.controller.retry();
    test.waiters[1]!(lease());
    await settle();
    expect(test.controller.getSnapshot()?.phase).toBe("project");
  });
});
