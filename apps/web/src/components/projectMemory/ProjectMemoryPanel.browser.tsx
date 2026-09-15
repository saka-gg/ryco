import "../../index.css";
import { page } from "vite-plus/test/browser";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import {
  EnvironmentId,
  ProjectId,
  type ProjectMemoryApi,
  type ProjectMemoryEntry,
} from "@ryco/contracts";
import { createProjectMemoryController } from "@ryco/client-runtime/state/project-memory";
import { ProjectMemoryPanel } from "./ProjectMemoryPanel";
const projectId = ProjectId.make("fixture");
const entry: ProjectMemoryEntry = {
  id: "entry",
  projectId,
  kind: "convention",
  text: "Keep integration tests in tests/integration.",
  revision: 2,
  pinned: false,
  createdAt: "2026-09-15T00:00:00Z",
  updatedAt: "2026-09-15T00:00:00Z",
  affirmedAt: "2026-09-15T00:00:00Z",
  provenance: { kind: "user", actorId: "b".repeat(64) },
};
let mounted: Awaited<ReturnType<typeof render>> | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});
it("curates and visibly previews explicit recall; deletion needs explicit confirmation", async () => {
  const mutate = vi.fn(async () => ({ revision: 3 }));
  const api: ProjectMemoryApi = {
    list: async () => ({
      enabled: true,
      revision: 2,
      entries: [entry],
      total: 1,
      matched: 1,
      nextOffset: null,
      asOf: "2026-09-15T00:00:00Z",
    }),
    mutate,
    preview: async () => ({ entries: [entry], envelopeBytes: 420 }),
    export: async () => ({
      version: 1,
      projectId,
      enabled: true,
      exportedAt: "2026-09-15T00:00:00Z",
      entries: [entry],
    }),
  };
  const controller = createProjectMemoryController({
    environmentId: EnvironmentId.make("node"),
    projectId,
    readConnection: () => ({ api, ready: true, generation: 1 }),
  });
  mounted = await render(
    <div className="bg-background">
      <ProjectMemoryPanel controller={controller} />
    </div>,
  );
  await expect.element(page.getByText(entry.text)).toBeVisible();
  await page.getByRole("button", { name: "Select for recall", exact: true }).click();
  expect(controller.reviewedRecall()).toBeNull();
  await page.getByRole("button", { name: "Review selected memories" }).click();
  await expect.element(page.getByText("420 / 16,384 bytes · Quoted reference data")).toBeVisible();
  expect(controller.reviewedRecall()?.references).toEqual([{ id: "entry", revision: 2 }]);
  await page
    .getByRole("region", { name: "Selected project memory" })
    .screenshot({ path: "__screenshots__/project-memory-review.png" });
  await page.getByRole("button", { name: "Forget", exact: true }).click();
  expect(mutate).not.toHaveBeenCalled();
  await expect.element(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "Confirm deletion" }).click();
  expect(mutate).toHaveBeenCalledWith({
    projectId,
    expectedRevision: 2,
    mutation: { operation: "forget", id: "entry", revision: 2 },
  });
});
