import { AgentControlAutomationId, EnvironmentId, ProjectId } from "@ryco/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import {
  closeAutomationsDialog,
  openAutomationsDialog,
  rememberAutomationsDialogProject,
  resetAutomationsDialogStoreForTests,
  useAutomationsDialogStore,
} from "./automationsDialogStore";

const LOCAL = EnvironmentId.make("env-local");
const origin = { id: "origin" } as unknown as HTMLElement;
const other = { id: "other" } as unknown as HTMLElement;

afterEach(() => resetAutomationsDialogStoreForTests());

describe("automationsDialogStore", () => {
  it("opens on the last project by default and bumps the token on every open", () => {
    openAutomationsDialog();
    const first = useAutomationsDialogStore.getState();
    expect(first).toMatchObject({
      open: true,
      token: 1,
      origin: null,
      request: { project: { kind: "last" }, automationId: null, mode: "view", environmentId: null },
    });
    openAutomationsDialog();
    expect(useAutomationsDialogStore.getState().token).toBe(2);
  });

  it("normalizes a project key or a checkout, with a schedule, a mode and a device", () => {
    openAutomationsDialog({ projectKey: "ryco", mode: "new", environmentId: LOCAL, origin });
    expect(useAutomationsDialogStore.getState()).toMatchObject({
      origin,
      request: { project: { kind: "key", projectKey: "ryco" }, mode: "new", environmentId: LOCAL },
    });
    closeAutomationsDialog();
    const automationId = AgentControlAutomationId.make("auto-1");
    openAutomationsDialog({
      environmentId: LOCAL,
      projectId: ProjectId.make("p"),
      automationId,
      mode: "edit",
    });
    expect(useAutomationsDialogStore.getState().request).toEqual({
      project: { kind: "checkout", environmentId: LOCAL, projectId: "p" },
      automationId,
      mode: "edit",
      environmentId: LOCAL,
    });
  });

  it("keeps the request while closing and the first origin only while open", () => {
    openAutomationsDialog({ projectKey: "ryco", origin });
    openAutomationsDialog({ projectKey: "hub", origin: other });
    expect(useAutomationsDialogStore.getState().origin).toBe(origin);
    closeAutomationsDialog();
    // The popup captured its origin on mount; a closed dialog pins no control.
    expect(useAutomationsDialogStore.getState()).toMatchObject({
      open: false,
      origin: null,
      request: { project: { kind: "key", projectKey: "hub" } },
    });
    openAutomationsDialog({ origin: other });
    expect(useAutomationsDialogStore.getState().origin).toBe(other);
  });

  it("remembers the project it showed", () => {
    rememberAutomationsDialogProject({
      projectKey: "ryco",
      environmentId: LOCAL,
      id: ProjectId.make("p"),
    } as SidebarProjectSnapshot);
    expect(useAutomationsDialogStore.getState().lastProject).toEqual({
      projectKey: "ryco",
      environmentId: LOCAL,
      projectId: "p",
    });
  });
});
