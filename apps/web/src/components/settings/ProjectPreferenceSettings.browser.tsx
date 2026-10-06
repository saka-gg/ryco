import "../../index.css";
import { render } from "vitest-browser-react";
import { page } from "vite-plus/test/browser";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  type EffectiveProjectPreferences,
  type ServerConfig,
  type ServerSettingsPatch,
} from "@ryco/contracts";
import { applyServerSettingsPatch } from "@ryco/shared/serverSettings";
import { ProjectDefaultsSection } from "./ProjectDefaultsSection";
import { ProjectPreferenceSettings } from "./ProjectPreferenceSettings";
import { SettingsCard } from "./settingsLayout";

const harness = vi.hoisted(() => ({
  config: null as ServerConfig | null,
  connected: true,
  canManage: true,
  canMutate: true,
  projects: [{ id: "p", name: "Fixture project", environmentId: "fixture-node" }],
  read: vi.fn(),
  update: vi.fn(),
  local: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => harness.navigate,
}));
vi.mock("../../composerDraftStore", () => ({ DraftId: { make: (value: string) => value } }));
vi.mock("../chat/ProviderModelPicker", () => ({
  ProviderModelPicker: () => <span>Model picker</span>,
}));
vi.mock("../chat/TraitsPicker", () => ({ TraitsPicker: () => <span>Traits picker</span> }));
vi.mock("../../rpc/serverState", () => ({
  useServerConfig: () => harness.config,
  applySettingsUpdated: vi.fn(),
}));
vi.mock("../../settingsTarget", () => ({
  useSettingsEditingScope: () => "node",
  useSettingsTarget: () => ({
    environmentId: "fixture-node",
    nodeLabel: "Fixture node",
    serverConfig: harness.config,
    connected: harness.connected,
    canManage: harness.canManage,
    canMutate: harness.canMutate,
  }),
}));
vi.mock("../../store", () => ({
  useStore: () => harness.projects,
  selectProjectsAcrossEnvironments: vi.fn(),
}));
vi.mock("../../hostedHub/capabilities", () => ({
  useHostedRpcCapability: () => ({ allowed: harness.canMutate }),
}));
vi.mock("../../environmentApi", () => ({
  ensureEnvironmentApi: () => ({ server: { getProjectPreferences: harness.read } }),
}));
vi.mock("../../environments/runtime", () => ({
  updateEnvironmentServerSettings: (...args: unknown[]) => harness.update(...args),
}));
vi.mock("../../localApi", () => ({ ensureLocalApi: harness.local }));

const FIXTURE_PROJECT_CHOICES = [{ id: "p", title: "Fixture project" }];

beforeEach(() => {
  harness.connected = true;
  harness.canManage = true;
  harness.canMutate = true;
  harness.projects = [{ id: "p", name: "Fixture project", environmentId: "fixture-node" }];
  harness.config = {
    environment: {
      environmentId: EnvironmentId.make("fixture-node"),
      capabilities: { projectPreferences: true },
    },
    settings: DEFAULT_SERVER_SETTINGS,
    providers: [],
  } as unknown as ServerConfig;
  harness.read.mockReset();
  harness.update.mockReset();
  harness.local.mockReset();
  harness.navigate.mockReset();
  harness.read.mockImplementation(async ({ projectId }: { projectId?: ProjectId }) => {
    const overrides = projectId
      ? (harness.config!.settings.projectPreferences[projectId] ?? {})
      : {};
    return {
      initialModelSelection: {
        value: { instanceId: "codex", model: "fixture-model" },
        source: "builtin",
      },
      defaultThreadEnvMode: { value: "local", source: "node" },
      worktreeBranchPrefix: { value: "ryco", source: "node" },
      worktreeRoot: { value: "", source: "builtin" },
      runSetupScript: {
        value: overrides.runSetupScript ?? true,
        source: overrides.runSetupScript === undefined ? "node" : "project",
      },
      overrides,
    } as EffectiveProjectPreferences;
  });
  harness.update.mockImplementation(async (_environmentId: string, patch: ServerSettingsPatch) => {
    harness.config = {
      ...harness.config!,
      settings: applyServerSettingsPatch(harness.config!.settings, patch),
    };
  });
});

describe("project inheritance controls", () => {
  it("shows effective inheritance, writes only one project field, and resets to node defaults", async () => {
    // Per-project overrides render on the projects page, scoped to one project.
    await render(
      <SettingsCard>
        <ProjectPreferenceSettings projectId="p" projects={FIXTURE_PROJECT_CHOICES} />
      </SettingsCard>,
    );
    await expect
      .element(page.getByText("Inherited from device defaults", { exact: true }).first())
      .toBeVisible();
    await page.getByRole("combobox", { name: "Worktree setup" }).click();
    await page.getByRole("option", { name: "Skip setup" }).click();
    await expect
      .poll(() => harness.update.mock.calls)
      .toEqual([
        [
          "fixture-node",
          {
            projectPreferences: { p: { runSetupScript: false } },
            expectedProjectPreferences: { p: { runSetupScript: null } },
          },
        ],
      ]);
    await expect
      .element(page.getByText("Overridden for this project", { exact: true }))
      .toBeVisible();
    await page.getByRole("button", { name: "Use device default for worktree setup" }).click();
    await expect
      .poll(() => harness.update.mock.calls[1])
      .toEqual([
        "fixture-node",
        {
          projectPreferences: { p: { runSetupScript: null } },
          expectedProjectPreferences: { p: { runSetupScript: false } },
        },
      ]);
    expect(harness.local).not.toHaveBeenCalled();
  });
  it("keeps disconnected, read-only and hosted-unready targets disabled without reading another node", async () => {
    harness.connected = false;
    harness.canManage = false;
    harness.canMutate = false;
    await render(<ProjectDefaultsSection />);
    await expect
      .element(page.getByRole("combobox", { name: "Default thread mode" }))
      .toBeDisabled();
    expect(harness.read).not.toHaveBeenCalled();
    expect(harness.local).not.toHaveBeenCalled();
  });
  it("preserves the editor on stale writes and reloads effective values", async () => {
    harness.update.mockRejectedValue(
      new Error("Project preferences changed elsewhere. Reload before saving."),
    );
    await render(<ProjectDefaultsSection />);
    await expect.element(page.getByRole("combobox", { name: "Worktree setup" })).toBeEnabled();
    await page.getByRole("combobox", { name: "Worktree setup" }).click();
    await page.getByRole("option", { name: "Skip setup" }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("changed elsewhere");
    await page.getByRole("button", { name: "Reload", exact: true }).click();
    await expect.poll(() => harness.read.mock.calls.length).toBeGreaterThan(1);
    expect(harness.local).not.toHaveBeenCalled();
  });
  it("does not fall back to node defaults when a selected project is removed", async () => {
    const mounted = await render(
      <ProjectPreferenceSettings projectId="p" projects={FIXTURE_PROJECT_CHOICES} />,
    );
    await expect.element(page.getByRole("combobox", { name: "Worktree setup" })).toBeEnabled();
    await expect
      .element(page.getByText("Inherited from device defaults", { exact: true }).first())
      .toBeVisible();
    await mounted.rerender(<ProjectPreferenceSettings projectId="p" projects={[]} />);
    await expect.element(page.getByRole("alert")).toHaveTextContent("Project no longer exists");
    await expect.element(page.getByRole("combobox", { name: "Worktree setup" })).toBeDisabled();
    expect(harness.update).not.toHaveBeenCalled();
  });
  it("keeps device defaults here and links to per-project overrides on the projects page", async () => {
    await render(<ProjectDefaultsSection />);
    await expect
      .element(page.getByRole("combobox", { name: "Project default scope" }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: /Per-project overrides/ }).click();
    expect(harness.navigate).toHaveBeenCalledWith({
      to: "/projects",
      search: { env: "fixture-node", project: "p", section: "defaults" },
    });
  });
});
