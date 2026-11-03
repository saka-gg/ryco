import "../../index.css";

import { EnvironmentId, ProjectId, type ContextMenuItem } from "@ryco/contracts";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { ProjectNotOnBlock } from "../projects/sections/ProjectDevicesSection";
import { useSidebarProjectContextMenu } from "../sidebar/hooks/useSidebarProjectContextMenu";
import { ProjectSettingsMenu } from "../sidebar/ProjectSettingsMenu";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import {
  crossNodeProjectActions,
  resetProjectNodesDialogStoreForTests,
  useProjectNodesDialogStore,
  type CopyProjectDialogOrigin,
  type CrossNodeProjectActions,
} from "./projectNodesDialogStore";

const LAPTOP = EnvironmentId.make("env-laptop");
const MINI = EnvironmentId.make("env-mini");
const HETZNER = EnvironmentId.make("env-hetzner");
const PROJECT = ProjectId.make("project-ryco");

const member = (environmentId: EnvironmentId, id: string, cwd: string, label: string | null) => ({
  id: ProjectId.make(id),
  environmentId,
  name: "ryco",
  cwd,
  scripts: [],
  defaultModelSelection: null,
  physicalProjectKey: `${environmentId}:${id}`,
  environmentLabel: label,
});

const project = {
  ...member(LAPTOP, "project-ryco", "/Users/me/Code/ryco", null),
  projectKey: "github.com/sak0a/ryco",
  displayName: "ryco",
  groupedProjectCount: 2,
  environmentPresence: "mixed",
  memberProjects: [
    member(LAPTOP, "project-ryco", "/Users/me/Code/ryco", null),
    member(MINI, "project-ryco-mini", "/Users/me/dev/ryco", "Mac mini"),
  ],
  memberProjectRefs: [
    { environmentId: LAPTOP, projectId: PROJECT },
    { environmentId: MINI, projectId: ProjectId.make("project-ryco-mini") },
  ],
  remoteEnvironmentLabels: ["Mac mini"],
} as unknown as SidebarProjectSnapshot;

function actionsFor(origin: CopyProjectDialogOrigin, openAddProject = vi.fn()) {
  return crossNodeProjectActions({
    projectRef: { environmentId: LAPTOP, projectId: PROJECT },
    origin,
    openAddProject,
  });
}

function Kebab(props: { readonly crossNodeActions?: CrossNodeProjectActions | undefined }) {
  return (
    <AppAtomRegistryProvider>
      <Menu defaultOpen>
        <MenuTrigger>Project actions</MenuTrigger>
        <MenuPopup>
          <ProjectSettingsMenu
            jiraProjectOpenUrlByProjectKey={new Map()}
            project={project}
            onCopyPath={vi.fn()}
            onGrouping={vi.fn()}
            onNewFolderWithProject={vi.fn()}
            onOpenJiraProject={vi.fn()}
            onOpenOverview={vi.fn()}
            onOpenRemote={vi.fn()}
            onRemove={vi.fn()}
            onRename={vi.fn()}
            onSettings={vi.fn()}
            crossNodeActions={props.crossNodeActions}
          />
        </MenuPopup>
      </Menu>
    </AppAtomRegistryProvider>
  );
}

function ContextMenuHarness(props: {
  readonly crossNodeActions?: CrossNodeProjectActions | undefined;
}) {
  const suppress = useRef(false);
  const { handleProjectButtonContextMenu } = useSidebarProjectContextMenu({
    project,
    jiraProjectOpenUrlByProjectKey: new Map(),
    suppressProjectClickForContextMenuRef: suppress,
    onOpenOverview: vi.fn(),
    openProjectSettingsDialog: vi.fn(),
    openProjectRemoteLink: vi.fn(),
    openProjectJiraLink: vi.fn(),
    openProjectRenameDialog: vi.fn(),
    openProjectGroupingDialog: vi.fn(),
    copyPathToClipboard: vi.fn(),
    handleRemoveProject: vi.fn(async () => undefined),
    crossNodeActions: props.crossNodeActions,
  });
  return (
    <button type="button" onContextMenu={handleProjectButtonContextMenu}>
      ryco
    </button>
  );
}

const contextMenuShow = vi.fn<(items: readonly ContextMenuItem[]) => Promise<string | null>>();

beforeEach(() => {
  resetProjectNodesDialogStoreForTests();
  contextMenuShow.mockReset();
  (window as unknown as { nativeApi: unknown }).nativeApi = {
    contextMenu: { show: (items: readonly ContextMenuItem[]) => contextMenuShow(items) },
  };
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("cross-node entry points", () => {
  it("the kebab offers copy and link and lists the project's nodes", async () => {
    const screen = await render(<Kebab crossNodeActions={actionsFor("kebab")} />);
    try {
      const copy = page.getByRole("menuitem", { name: /Copy to another node…/u });
      await expect.element(copy).toMatchTextContent("New");
      await expect
        .element(page.getByRole("menuitem", { name: "Link a copy that’s already on a node…" }))
        .toBeVisible();
      const nodes = page.getByRole("group", { name: "On 2 nodes" });
      await expect.element(nodes).toMatchTextContent("This device~/Code/ryco");
      await expect.element(nodes).toMatchTextContent("Mac mini~/dev/ryco");

      await copy.click();
      const { copyProject } = useProjectNodesDialogStore.getState();
      expect(copyProject.open).toBe(true);
      expect(copyProject.request).toEqual({
        source: { environmentId: LAPTOP, projectId: PROJECT },
        targetEnvironmentId: null,
        origin: "kebab",
      });
    } finally {
      await screen.unmount();
    }
  });

  it("linking opens add project in link mode for the checkout", async () => {
    const openAddProject = vi.fn();
    const screen = await render(<Kebab crossNodeActions={actionsFor("kebab", openAddProject)} />);
    try {
      await page.getByRole("menuitem", { name: "Link a copy that’s already on a node…" }).click();
      expect(openAddProject).toHaveBeenCalledTimes(1);
      expect(openAddProject).toHaveBeenCalledWith({
        mode: "link",
        projectRef: { environmentId: LAPTOP, projectId: PROJECT },
      });
    } finally {
      await screen.unmount();
    }
  });

  it("a kebab without cross-node actions (the phone tier) shows none of them", async () => {
    const screen = await render(<Kebab />);
    try {
      await expect.element(page.getByRole("menuitem", { name: "Project overview" })).toBeVisible();
      expect(document.body.textContent).not.toContain("Copy to another node");
      expect(document.body.textContent).not.toContain("Link a copy");
      expect(document.querySelector('[data-testid="project-menu-nodes"]')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("the native context menu offers copy and link when the surface opts in", async () => {
    contextMenuShow.mockResolvedValue("copy-to-node");
    const screen = await render(<ContextMenuHarness crossNodeActions={actionsFor("sidebar")} />);
    try {
      await page.getByRole("button", { name: "ryco" }).click({ button: "right" });
      await vi.waitFor(() => expect(contextMenuShow).toHaveBeenCalledTimes(1));
      const labels = contextMenuShow.mock.calls[0]![0].map((item) => item.label);
      expect(labels).toContain("Copy to another node…");
      expect(labels).toContain("Link a copy that’s already on a node…");
      await vi.waitFor(() =>
        expect(useProjectNodesDialogStore.getState().copyProject.request).toEqual({
          source: { environmentId: LAPTOP, projectId: PROJECT },
          targetEnvironmentId: null,
          origin: "sidebar",
        }),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("the native context menu has no cross-node items without the opt-in", async () => {
    contextMenuShow.mockResolvedValue(null);
    const screen = await render(<ContextMenuHarness />);
    try {
      await page.getByRole("button", { name: "ryco" }).click({ button: "right" });
      await vi.waitFor(() => expect(contextMenuShow).toHaveBeenCalledTimes(1));
      const labels = contextMenuShow.mock.calls[0]![0].map((item) => item.label);
      expect(labels).not.toContain("Copy to another node…");
      expect(labels).not.toContain("Link a copy that’s already on a node…");
    } finally {
      await screen.unmount();
    }
  });

  it("“Not on” offers Copy here with that node picked", async () => {
    const screen = await render(
      <ProjectNotOnBlock
        member={{ environmentId: LAPTOP, id: PROJECT }}
        missing={[{ environmentId: HETZNER, label: "hetzner-build" }]}
        crossNode
      />,
    );
    try {
      await page.getByRole("button", { name: "Copy here: hetzner-build" }).click();
      expect(useProjectNodesDialogStore.getState().copyProject.request).toEqual({
        source: { environmentId: LAPTOP, projectId: PROJECT },
        targetEnvironmentId: HETZNER,
        origin: "devices-section",
      });
    } finally {
      await screen.unmount();
    }
  });

  it("“Not on” stays a plain list on the phone tier", async () => {
    const screen = await render(
      <ProjectNotOnBlock
        member={{ environmentId: LAPTOP, id: PROJECT }}
        missing={[
          { environmentId: HETZNER, label: "hetzner-build" },
          { environmentId: MINI, label: "Mac mini" },
        ]}
        crossNode={false}
      />,
    );
    try {
      await expect.element(page.getByText("Not on hetzner-build, Mac mini")).toBeVisible();
      expect(document.querySelector('[data-testid="project-not-on"]')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});
