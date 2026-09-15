import { describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  type ProjectMemoryApi,
  type ProjectMemoryEntry,
  type ProjectMemoryPage,
} from "@ryco/contracts";
import { createProjectMemoryController, type ProjectMemoryConnection } from "./index.ts";
const projectId = ProjectId.make("project");
const entry: ProjectMemoryEntry = {
  id: "entry",
  projectId,
  kind: "fact",
  text: "Use focused checks.",
  revision: 2,
  pinned: false,
  createdAt: "2026-09-15T00:00:00Z",
  updatedAt: "2026-09-15T00:00:00Z",
  affirmedAt: "2026-09-15T00:00:00Z",
  provenance: { kind: "user", actorId: "a".repeat(64) },
};
const page: ProjectMemoryPage = {
  enabled: true,
  revision: 2,
  entries: [entry],
  total: 1,
  matched: 1,
  nextOffset: null,
  asOf: "2026-09-15T00:00:00Z",
};
function fixture() {
  const api: ProjectMemoryApi = {
    list: vi.fn(async () => page),
    mutate: vi.fn(async () => ({ revision: 3 })),
    preview: vi.fn(async () => ({ entries: [entry], envelopeBytes: 350 })),
    export: vi.fn(async () => ({
      version: 1,
      projectId,
      enabled: true,
      exportedAt: page.asOf,
      entries: [entry],
    })),
  };
  let connection: ProjectMemoryConnection = { api, generation: 1, ready: true };
  const controller = createProjectMemoryController({
    environmentId: EnvironmentId.make("node"),
    projectId,
    readConnection: () => connection,
  });
  return {
    controller,
    api,
    setConnection: (next: ProjectMemoryConnection) => {
      connection = next;
    },
  };
}
describe("project memory controller", () => {
  it("requires explicit selection and preview, queues only references", async () => {
    const { controller, api } = fixture();
    await controller.refresh();
    expect(api.preview).not.toHaveBeenCalled();
    controller.toggleRecall(entry);
    expect(controller.reviewedRecall()).toBeNull();
    await controller.previewRecall();
    expect(controller.reviewedRecall()).toEqual({
      projectId,
      references: [{ id: "entry", revision: 2 }],
    });
    expect(JSON.stringify(controller.reviewedRecall())).not.toContain(entry.text);
  });
  it("a changed connection generation invalidates preview even without a rendered disconnect", async () => {
    const { controller, api, setConnection } = fixture();
    await controller.refresh();
    controller.toggleRecall(entry);
    await controller.previewRecall();
    setConnection({ api, generation: 2, ready: true });
    expect(controller.reviewedRecall()).toBeNull();
  });
  it("late fetch from a stale generation cannot publish content or readiness", async () => {
    const { controller, api, setConnection } = fixture();
    let finish!: (value: ProjectMemoryPage) => void;
    api.list = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const pending = controller.refresh();
    setConnection({ api, generation: 2, ready: false });
    finish(page);
    await pending;
    expect(controller.getSnapshot().page).toBeNull();
    expect(controller.reviewedRecall()).toBeNull();
  });
  it("mutation uses the displayed revision and clears transient recall", async () => {
    const { controller, api } = fixture();
    await controller.refresh();
    controller.toggleRecall(entry);
    await controller.previewRecall();
    await controller.mutate({ operation: "forget", id: "entry", revision: 2 });
    expect(api.mutate).toHaveBeenCalledWith({
      projectId,
      expectedRevision: 2,
      mutation: { operation: "forget", id: "entry", revision: 2 },
    });
    expect(controller.reviewedRecall()).toBeNull();
  });
  it("does not send while unready and drops text on invalidation", async () => {
    const { controller, api, setConnection } = fixture();
    await controller.refresh();
    setConnection({ api, generation: 2, ready: false });
    await controller.mutate({ operation: "deleteAll" });
    expect(api.mutate).not.toHaveBeenCalled();
    expect(controller.getSnapshot().page).toBeNull();
  });
});
