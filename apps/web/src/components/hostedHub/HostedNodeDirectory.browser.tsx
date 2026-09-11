// The node directory's new surface area: the details affordance, the metadata
// sheet, the empty state, and account settings being reachable at all before a
// node is selected.
//
// What is pinned here is behaviour a user depends on rather than markup:
//
//   * the details control stays operable in exactly the states where connecting
//     does not — a revoked node, a stale directory — because that is the whole
//     reason it exists;
//   * the two nullable timestamps render their own null meaning, asserted
//     separately, because swapping them prints a false negative about a live
//     machine;
//   * exactly one enroll control exists, and none at all for an account that
//     cannot enroll;
//   * account settings is mounted on the directory, and mounted exactly once.
import "../../index.css";

import { EnvironmentId, ProjectId, ThreadId } from "@ryco/contracts";
import { workspaceMetadataPayloadBytes } from "@ryco/client-runtime/state/workspace";
import { page, userEvent } from "vite-plus/test/browser";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const navigate = vi.fn(async () => undefined);
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
  useParams: () => undefined,
  useRouter: () => ({
    state: { matches: [] },
    navigate,
  }),
}));

// The hosted client is what these suites are about, and nothing in a browser
// test carries `VITE_RYCO_CLIENT_MODE`: there is no `.env` in this harness, so
// `import.meta.env.VITE_RYCO_CLIENT_MODE` is replaced at build time with
// `"standard"` and `isHostedHubMode()` answered **false** in every hosted
// browser suite. Anything gated on it therefore ran in the wrong client:
// `SettingsDialog` filtered the Account section out entirely and its own effect
// rewrote `section` to `"general"`, so a test that opened account settings was
// racing that rewrite and asserting against the standard dialog. The mode is
// resolved once at module scope from a build-time constant, so a test cannot
// set it — the module that reads it is the seam.
vi.mock("../../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../env")>()),
  readRycoClientMode: () => "hosted-hub" as const,
  isHostedHubMode: () => true,
}));

import { syncDocumentPresentationTier } from "../../lib/presentationTier";
import { hostedHubApi, HostedHubApiError } from "../../hostedHub/api";
import { hostedHubController, useHostedHubStore } from "../../hostedHub/state";
import { navigateHub, resetHubRoutesForTests } from "../../hostedHub/hubRoutes";
import { useSettingsDialogStore } from "../../settingsDialogStore";
import type { HostedHubNode } from "../../hostedHub/types";
import { HostedHubRoot } from "./HostedHubRoot";
import { createBrowserWorkspaceMetadataCache } from "../../persistence/workspaceMetadataCache";

const account = {
  id: "acct_aaaaaaaaaaaaaaaaaaaaaa",
  displayName: "Ada",
  role: "owner" as const,
  createdAt: 1,
  disabledAt: null,
};
const session = {
  id: "sess_aaaaaaaaaaaaaaaaaaaaaaa".slice(0, 27),
  accountId: account.id,
  createdAt: 1,
  expiresAt: 2,
  lastSeenAt: 1,
  revokedAt: null,
  revocationReasonCode: null,
};

const NOW = Date.now();

function node(overrides: Partial<HostedHubNode> = {}): HostedHubNode {
  return {
    id: "node_aaaaaaaaaaaaaaaaaaaaaa",
    environmentId: EnvironmentId.make(`env_${"a".repeat(22)}`),
    label: "Studio",
    platformOs: "darwin",
    platformArch: "arm64",
    clientVersion: "0.9.7",
    createdAt: NOW - 10_000_000,
    updatedAt: NOW - 1_000,
    lastAuthenticatedAt: NOW - 3_600_000,
    revokedAt: null,
    revocationReasonCode: null,
    grant: { id: "grant_aaaaaaaaaaaaaaaaaaaaaa", role: "operator" },
    effectiveRole: "operator",
    presence: { online: true, lastHeartbeatAt: NOW - 5_000 },
    ...overrides,
  };
}

function seedDirectory(nodes: ReadonlyArray<HostedHubNode>, overrides: object = {}): void {
  useHostedHubStore.setState({
    accountStatus: "authenticated",
    account,
    session,
    directoryStatus: "ready",
    browserStatus: "current",
    nodes: [...nodes],
    ...overrides,
  });
}

/**
 * Every row's details control, by accessible name and in DOM order. The name is
 * where node identity lives, so this is also what proves the ordering.
 */
function detailsNames(): ReadonlyArray<string> {
  return [
    ...document.querySelectorAll<HTMLElement>(
      'ul[role="list"] button[aria-label^="Node details: "]',
    ),
  ].map((button) => button.getAttribute("aria-label")!);
}

function detailsNodeLabels(): ReadonlyArray<string> {
  return detailsNames().map((name) => name.replace("Node details: ", ""));
}

/** The confirmation dialog's rendered text, or `""` when it is not up. */
function revokeDialogText(): string {
  return document.querySelector<HTMLElement>('[data-slot="dialog-popup"]')?.textContent ?? "";
}

/**
 * The confirmation's text, but only while it is actually STAYING open.
 *
 * `revokeDialogText` alone cannot tell an open dialog from one that is 240ms
 * into being dismissed: `dialog-popup` carries
 * `transition-[scale,opacity,translate] duration-[240ms]`, and Base UI keeps a
 * closing popup mounted for the whole exit. Every assertion that runs
 * synchronously after a click therefore reads a dialog that is already on its
 * way out and cannot see the difference — which is how "keeps the row standing
 * when the revoke is refused" stayed green against a dialog that dismissed
 * itself the instant the Hub refused. Base UI stamps `data-ending-style` for the
 * duration of the exit, so this refuses to count one.
 */
function stayingOpenDialogText(): string {
  const popup = document.querySelector<HTMLElement>('[data-slot="dialog-popup"]');
  if (!popup || popup.hasAttribute("data-ending-style")) return "";
  return popup.textContent ?? "";
}

/** Past the popup's 240ms exit transition, so a closing dialog has really gone. */
async function settleDialogTransition(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 400));
}

syncDocumentPresentationTier();

let mounted: Awaited<ReturnType<typeof render>> | null = null;

function resetDirectoryRouteForTests(): void {
  resetHubRoutesForTests();
  navigateHub({ kind: "nodes" }, { replace: true });
}

beforeEach(async () => {
  // Desktop by default: the tier fork decides which account entry point and
  // which settings presentation exist, so it must be asserted rather than
  // inherited from whatever size the harness iframe happens to be.
  await page.viewport(1_280, 720);
  await vi.waitFor(() => {
    expect(document.documentElement.getAttribute("data-tier")).toBe("desktop");
  });
  localStorage.clear();
  sessionStorage.clear();
  hostedHubController.resetForTests();
  resetDirectoryRouteForTests();
  useSettingsDialogStore.setState({ open: false, section: "general" });
  navigate.mockClear();
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  hostedHubController.resetForTests();
  resetDirectoryRouteForTests();
  useSettingsDialogStore.setState({ open: false, section: "general" });
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("hosted node directory", () => {
  it("renders a cached cross-node workspace without eagerly acquiring its node", async () => {
    const cachedNode = node({ environmentId: EnvironmentId.make(`env_${"c".repeat(22)}`) });
    const projectId = ProjectId.make("cached-project");
    const snapshot = {
      schemaVersion: 1 as const,
      environmentId: cachedNode.environmentId,
      capturedAt: NOW,
      projects: [
        {
          environmentId: cachedNode.environmentId,
          id: projectId,
          name: "Cached workspace",
          cwd: "/cached",
          repositoryIdentity: null,
          createdAt: null,
          updatedAt: null,
        },
      ],
      worktrees: [],
      threads: [
        {
          environmentId: cachedNode.environmentId,
          id: ThreadId.make("cached-thread"),
          projectId,
          worktreeId: null,
          title: "Cached thread from another node",
          createdAt: new Date(NOW).toISOString(),
          updatedAt: null,
          archivedAt: null,
          modelSelection: null,
          providerDriver: null,
          branch: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
          deliveryUnknown: false,
        },
      ],
    };
    await createBrowserWorkspaceMetadataCache(localStorage).replace({
      namespace: {
        hubOrigin: window.location.origin,
        accountId: account.id,
        environmentId: cachedNode.environmentId,
      },
      snapshot,
      payloadBytes: workspaceMetadataPayloadBytes(snapshot),
      updatedAt: NOW,
    });
    seedDirectory([cachedNode]);
    const selectNode = vi.spyOn(hostedHubController, "selectNode");
    const rootRoute = createRootRoute({ component: HostedHubRoot });
    const router = createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    resetHubRoutesForTests();
    mounted = await render(<RouterProvider router={router} />);

    await expect.element(page.getByTestId("inbox-thread-row")).toBeVisible();
    const cachedThreadRow = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-testid="inbox-thread-row"]'),
    ).find((candidate) => candidate.textContent?.includes("Cached thread from another node"));
    expect(cachedThreadRow).toBeDefined();
    expect(cachedThreadRow?.textContent).toContain("Studio");
    expect(cachedThreadRow?.textContent).toContain("Cached workspace");
    expect(cachedThreadRow?.textContent).toContain("Local workspace");
    expect(selectNode).not.toHaveBeenCalled();
  });

  it("keeps native-only nodes locked with the required handoff copy", async () => {
    seedDirectory([
      node({
        capabilities: { repositoryIdentity: true, nativeClientRequired: true },
      }),
    ]);
    mounted = await render(<HostedHubRoot />);

    await expect.element(page.getByText("Open in Desktop/Mobile")).toBeVisible();
    await expect.element(page.getByRole("button", { name: /^Studio/ })).toBeDisabled();
    await page.getByRole("button", { name: "Node details: Studio" }).click();
    await expect.element(page.getByText("Open this node in Desktop/Mobile.")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Connect" })).toBeDisabled();
  });

  it("keeps node details reachable in exactly the states where connecting is not", async () => {
    // The metadata is needed *most* when the row will not connect: a revoked
    // grant and a stale directory are the two states whose explanation lives
    // behind this control. Disabling it would hide the explanation behind the
    // symptom.
    seedDirectory([node({ revokedAt: NOW, revocationReasonCode: "administrative" })], {
      directoryStatus: "stale",
    });
    mounted = await render(<HostedHubRoot />);

    await expect.element(page.getByRole("button", { name: /^Studio/ })).toBeDisabled();
    const details = page.getByRole("button", { name: "Node details: Studio" });
    await expect.element(details).toBeEnabled();

    await details.click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-slot="sheet-popup"]')).not.toBeNull();
    });
    // And it says why connecting is unavailable, in the words the connection
    // sheet already uses, rather than inventing a second vocabulary.
    await expect.element(page.getByText("Access to this node was revoked.")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Connect" })).toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Rename" })).toBeEnabled();
  });

  it("names only the action the stale banner actually disables", async () => {
    // The banner used to say "Actions are disabled until it refreshes" while
    // Rename and Revoke were both live underneath it — and Revoke is
    // irreversible. `nodeSelectionBlocked` gates connecting and nothing else, so
    // the sentence is narrowed to that rather than the controls being gated: a
    // directory whose poll is failing is not a Hub that cannot take a
    // revocation, and disabling the one control an owner reaches for during an
    // incident because a *read* went stale is the worse trade.
    seedDirectory([node()], { directoryStatus: "stale" });
    mounted = await render(<HostedHubRoot />);

    await expect.element(page.getByText(/Directory data is stale/)).toBeVisible();
    const banner = document.body.textContent ?? "";
    expect(banner, "the banner still claims every action is disabled").not.toContain(
      "Actions are disabled",
    );
    expect(banner).toContain("Connecting is unavailable until it refreshes");

    // The claim above is only true because these are what it describes.
    await expect.element(page.getByRole("button", { name: /^Studio/ })).toBeDisabled();
    await page.getByRole("button", { name: "Node details: Studio" }).click();
    await expect.element(page.getByRole("button", { name: "Connect" })).toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Revoke", exact: true })).toBeEnabled();
  });

  it("gives every row's details control an accessible name of its own", async () => {
    // Identity used to arrive as an `aria-describedby` description, which is
    // supplementary and is not what a name-based interface addresses: voice
    // control targets accessible NAMES, so N rows all named "Node details" left
    // "click Node details" ambiguous on every directory with more than one node.
    seedDirectory([
      node({ id: "node_aaaaaaaaaaaaaaaaaaaaaa", label: "Studio" }),
      node({ id: "node_bbbbbbbbbbbbbbbbbbbbbb", label: "Travel" }),
    ]);
    mounted = await render(<HostedHubRoot />);

    const names = detailsNames();
    expect(names).toEqual(["Node details: Studio", "Node details: Travel"]);
    expect(new Set(names).size, "two rows share one accessible name").toBe(names.length);
    // The action still leads, so a reader hears what the control does before
    // which machine it belongs to.
    for (const name of names) expect(name).toMatch(/^Node details: /);

    // And the identity goes AFTER the action for a reason: the connect control
    // stays the only accessible name that starts with the node's own label, so
    // a query for the row is not ambiguous with a query for its details.
    await expect.element(page.getByRole("button", { name: /^Studio/ })).toBeVisible();
    await expect.element(page.getByRole("button", { name: /^Travel/ })).toBeVisible();
  });

  it("renders each nullable timestamp with its own meaning", async () => {
    // Asserted separately on purpose. `lastAuthenticatedAt === null` genuinely
    // means the node has never authenticated. `lastHeartbeatAt === null` does
    // NOT mean it never sent a heartbeat — the contract permits null while the
    // node is online — so rendering "Never" there is a false negative about a
    // machine that is up.
    seedDirectory([
      node({
        presence: { online: true, lastHeartbeatAt: null },
        lastAuthenticatedAt: null,
      }),
    ]);
    mounted = await render(<HostedHubRoot />);
    await page.getByRole("button", { name: "Node details: Studio" }).click();

    await expect.element(page.getByText("Not reported")).toBeVisible();
    await expect.element(page.getByText("Never", { exact: true })).toBeVisible();
  });

  it("does not render the heartbeat's null as 'Never'", async () => {
    seedDirectory([
      node({
        presence: { online: true, lastHeartbeatAt: null },
        lastAuthenticatedAt: NOW - 3_600_000,
      }),
    ]);
    mounted = await render(<HostedHubRoot />);
    await page.getByRole("button", { name: "Node details: Studio" }).click();

    await expect.element(page.getByText("Not reported")).toBeVisible();
    await expect.element(page.getByText("Never", { exact: true })).not.toBeInTheDocument();
  });

  it("surfaces the node metadata the directory row cannot carry", async () => {
    seedDirectory([node()]);
    mounted = await render(<HostedHubRoot />);

    // The client version renders nowhere in the directory today, and it is the
    // only diagnostic for an `incompatible` selection.
    await expect.element(page.getByText("0.9.7")).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Node details: Studio" }).click();
    await expect.element(page.getByText("0.9.7")).toBeVisible();
    await expect.element(page.getByText("node_aaaaaaaaaaaaaaaaaaaaaa")).toBeVisible();
  });

  it("re-reads the open detail sheet from the store rather than pinning it to open-time values", async () => {
    // `listNodes` polls every 20 seconds and replaces every row. A sheet that
    // captured the node *object* stops tracking the machine it describes: the
    // revocation the poll delivered never renders, `nodeSelectionBlocked` reads
    // `revokedAt` off the stale snapshot so Connect stays enabled, and the
    // client version and heartbeat age keep reporting open-time values.
    seedDirectory([node()]);
    mounted = await render(<HostedHubRoot />);
    await page.getByRole("button", { name: "Node details: Studio" }).click();

    const sheetText = () =>
      document.querySelector<HTMLElement>('[data-slot="sheet-popup"]')?.textContent ?? "";
    await vi.waitFor(() => {
      expect(sheetText()).toContain("0.9.7");
    });
    expect(sheetText()).toContain("Online");
    await expect.element(page.getByRole("button", { name: "Connect" })).toBeEnabled();

    // The poll lands while the sheet is up: revoked, offline, upgraded, and
    // last heard from ten minutes ago.
    useHostedHubStore.setState({
      nodes: [
        node({
          revokedAt: NOW,
          revocationReasonCode: "administrative",
          clientVersion: "0.9.99",
          presence: { online: false, lastHeartbeatAt: NOW - 600_000 },
        }),
      ],
    });

    await vi.waitFor(() => {
      expect(sheetText(), "the sheet kept the open-time client version").toContain("0.9.99");
    });
    expect(sheetText(), "the sheet kept the open-time status").not.toContain("Online");
    expect(sheetText()).toContain("Revoked");
    expect(sheetText(), "the sheet kept the open-time heartbeat").toContain("10 min ago");
    expect(sheetText()).toContain("Access to this node was revoked.");
    // The decisive one: connecting to a node whose grant is gone.
    await expect.element(page.getByRole("button", { name: "Connect" })).toBeDisabled();
  });

  it("lets an owner rename the selected node and keeps its detail open by node ID", async () => {
    const selected = node({ id: "node_aaaaaaaaaaaaaaaaaaaaaa", label: "Studio" });
    const other = node({ id: "node_bbbbbbbbbbbbbbbbbbbbbb", label: "Travel" });
    seedDirectory([selected, other]);
    const renameNode = vi.spyOn(hostedHubApi, "renameNode").mockResolvedValue(undefined);
    const listNodes = vi
      .spyOn(hostedHubApi, "listNodes")
      .mockResolvedValue([other, node({ id: selected.id, label: "Workshop" })]);
    mounted = await render(<HostedHubRoot />);

    await page.getByRole("button", { name: "Node details: Studio" }).click();
    await page.getByRole("button", { name: "Rename" }).click();
    const input = page.getByRole("textbox", { name: "Device name" });
    await expect.element(input).toHaveValue("Studio");
    await input.fill("  Workshop  ");
    await page.getByRole("button", { name: "Save", exact: true }).click();

    expect(renameNode).toHaveBeenCalledWith(selected.id, "Workshop");
    await vi.waitFor(() => {
      expect(listNodes).toHaveBeenCalled();
      expect(detailsNames()).toEqual(["Node details: Travel", "Node details: Workshop"]);
    });
    await expect.element(page.getByRole("heading", { name: "Workshop" })).toBeVisible();
    await expect
      .element(page.getByRole("heading", { name: "Rename device" }))
      .not.toBeInTheDocument();
  });

  it("keeps unchanged, blank, and overlong rename values off the wire", async () => {
    seedDirectory([node()]);
    const renameNode = vi.spyOn(hostedHubApi, "renameNode").mockResolvedValue(undefined);
    mounted = await render(<HostedHubRoot />);

    await page.getByRole("button", { name: "Node details: Studio" }).click();
    await page.getByRole("button", { name: "Rename" }).click();
    const input = page.getByRole("textbox", { name: "Device name" });
    const save = page.getByRole("button", { name: "Save", exact: true });
    await expect.element(save).toBeDisabled();

    await input.fill(" ");
    await expect.element(page.getByText("Enter a device name.")).toBeVisible();
    await expect.element(save).toBeDisabled();

    await input.fill("N".repeat(101));
    await expect.element(page.getByText("Use 100 characters or fewer.")).toBeVisible();
    await expect.element(save).toBeDisabled();
    expect(renameNode).not.toHaveBeenCalled();
  });

  it("keeps the rename dialog recoverable when the mutation fails", async () => {
    seedDirectory([node()]);
    vi.spyOn(hostedHubApi, "renameNode").mockRejectedValue(
      new Error("You are not authorized to perform this action."),
    );
    mounted = await render(<HostedHubRoot />);

    await page.getByRole("button", { name: "Node details: Studio" }).click();
    await page.getByRole("button", { name: "Rename" }).click();
    const input = page.getByRole("textbox", { name: "Device name" });
    await input.fill("Workshop");
    await page.getByRole("button", { name: "Save", exact: true }).click();

    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("You are not authorized to perform this action.");
    await expect.element(page.getByRole("heading", { name: "Rename device" })).toBeVisible();
    await expect.element(input).toBeEnabled();
  });

  it("does not render rename for operators or viewers", async () => {
    for (const role of ["operator", "viewer"] as const) {
      useHostedHubStore.setState({
        accountStatus: "authenticated",
        account: { ...account, role },
        session,
        directoryStatus: "ready",
        browserStatus: "current",
        nodes: [node()],
      });
      mounted = await render(<HostedHubRoot />);
      await page.getByRole("button", { name: "Node details: Studio" }).click();
      await expect.element(page.getByRole("button", { name: "Rename" })).not.toBeInTheDocument();

      await mounted.unmount();
      mounted = null;
      hostedHubController.resetForTests();
      resetDirectoryRouteForTests();
    }
  });

  it("keeps rename on a tablet-width desktop presentation and out of the phone tier", async () => {
    await page.viewport(820, 720);
    await vi.waitFor(() => {
      expect(document.documentElement.getAttribute("data-tier")).toBe("desktop");
    });
    seedDirectory([node()]);
    mounted = await render(<HostedHubRoot />);
    await page.getByRole("button", { name: "Node details: Studio" }).click();
    await expect.element(page.getByRole("button", { name: "Rename" })).toBeVisible();

    await mounted.unmount();
    mounted = null;
    hostedHubController.resetForTests();
    resetDirectoryRouteForTests();
    await page.viewport(390, 720);
    await vi.waitFor(() => {
      expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
    });
    seedDirectory([node()]);
    mounted = await render(<HostedHubRoot />);
    await page.getByRole("button", { name: "Node details: Studio" }).click();
    await expect.element(page.getByRole("button", { name: "Rename" })).not.toBeInTheDocument();
  });

  it("reports a grant role only when it differs from the role in effect", async () => {
    seedDirectory([node({ grant: { id: "grant_a", role: "owner" }, effectiveRole: "operator" })]);
    mounted = await render(<HostedHubRoot />);
    await page.getByRole("button", { name: "Node details: Studio" }).click();
    await expect.element(page.getByText("Granted role")).toBeVisible();

    await mounted.unmount();
    mounted = null;
    hostedHubController.resetForTests();
    resetDirectoryRouteForTests();
    seedDirectory([
      node({ grant: { id: "grant_a", role: "operator" }, effectiveRole: "operator" }),
    ]);
    mounted = await render(<HostedHubRoot />);
    await page.getByRole("button", { name: "Node details: Studio" }).click();
    await expect.element(page.getByText("Your role")).toBeVisible();
    await expect.element(page.getByText("Granted role")).not.toBeInTheDocument();
  });

  it("offers an owner exactly one enroll control when no node exists", async () => {
    seedDirectory([]);
    mounted = await render(<HostedHubRoot />);

    await expect.element(page.getByText("No nodes yet")).toBeVisible();
    const enroll = [...document.querySelectorAll<HTMLElement>("button")].filter(
      (button) => button.textContent?.trim() === "Enroll node",
    );
    expect(enroll, "the empty state and the action group must not both offer it").toHaveLength(1);
  });

  it("offers a non-owner no enroll control at all, not even a disabled one", async () => {
    // A greyed control implies the capability is coming. It is not: the client
    // has no node write endpoints beyond enrollment approval, and enrollment is
    // owner-only.
    useHostedHubStore.setState({
      accountStatus: "authenticated",
      account: { ...account, role: "operator" },
      session,
      directoryStatus: "ready",
      browserStatus: "current",
      nodes: [],
    });
    mounted = await render(<HostedHubRoot />);

    await expect.element(page.getByText("No nodes yet")).toBeVisible();
    expect(
      [...document.querySelectorAll<HTMLElement>("button")].filter((button) =>
        button.textContent?.includes("Enroll"),
      ),
    ).toHaveLength(0);
  });

  it("orders the list revoked-last and does not reorder it when presence changes", async () => {
    // Presence is polled every 20 seconds and pauses with tab visibility, so a
    // presence sort reorders the list under the user's pointer on a cadence
    // they cannot predict.
    seedDirectory([
      node({ id: "node_b", label: "Bravo", presence: { online: false, lastHeartbeatAt: null } }),
      node({ id: "node_a", label: "Alpha", revokedAt: NOW }),
      node({ id: "node_c", label: "Charlie" }),
    ]);
    mounted = await render(<HostedHubRoot />);

    const labels = detailsNodeLabels;
    await vi.waitFor(() => {
      expect(labels()).toEqual(["Bravo", "Charlie", "Alpha"]);
    });

    useHostedHubStore.setState({
      nodes: [
        node({ id: "node_b", label: "Bravo", presence: { online: true, lastHeartbeatAt: NOW } }),
        node({ id: "node_a", label: "Alpha", revokedAt: NOW }),
        node({
          id: "node_c",
          label: "Charlie",
          presence: { online: false, lastHeartbeatAt: null },
        }),
      ],
    });
    await vi.waitFor(() => {
      expect(detailsNames()).toHaveLength(3);
    });
    expect(labels(), "presence must not be a sort key").toEqual(["Bravo", "Charlie", "Alpha"]);
  });

  it("keeps both of a row's focus indicators inside the row's clipping box", async () => {
    // The row is `overflow-hidden` — that is what keeps the divider and the
    // hover fill inside the radius — and both controls fill its padding box. An
    // OUTSET ring is a box-shadow drawn outside the border box, so it is clipped
    // on three sides and leaves a 2px sliver; with `outline-none` there is no
    // fallback behind it. WCAG 2.4.7.
    seedDirectory([node()]);
    mounted = await render(<HostedHubRoot />);

    const row = document.querySelector<HTMLElement>("li");
    expect(row, "no row to clip").not.toBeNull();
    // The clip is real, so the assertions below are about something.
    expect(getComputedStyle(row!).overflow).toBe("hidden");

    // Keyboard modality first: Chromium only matches `:focus-visible` when the
    // last interaction was a keyboard one, so a bare `focus()` asserts nothing.
    await userEvent.keyboard("{Tab}");
    for (const control of row!.querySelectorAll<HTMLElement>("button")) {
      control.focus();
      expect(document.activeElement).toBe(control);
      expect(control.matches(":focus-visible")).toBe(true);
      const shadow = getComputedStyle(control).boxShadow;
      expect(
        shadow,
        `${control.textContent ?? control.ariaLabel ?? "control"} has no indicator`,
      ).not.toBe("none");
      expect(
        shadow,
        `${control.textContent ?? control.ariaLabel ?? "control"} draws its indicator outside the clip`,
      ).toContain("inset");
    }
  });

  it("states the presence poll interval rather than animating a live indicator", async () => {
    // An "Online" pill can be twenty seconds stale, and longer while the tab is
    // backgrounded. Saying so costs one line; a pulsing dot would claim the
    // opposite.
    seedDirectory([node()]);
    mounted = await render(<HostedHubRoot />);
    await expect.element(page.getByText(/Presence refreshes about every 20 seconds/)).toBeVisible();
  });
});

describe("hosted node revocation", () => {
  it("names the node it is about, and sends nothing until the confirmation is taken", async () => {
    // The directory is a list of near-identical rows. A confirmation that does
    // not name its target catches an accidental click and nothing else — it
    // cannot catch a click on the WRONG row, which is the mistake this shape
    // actually produces. Two nodes sharing a label are the sharp case, so the
    // identifier has to be in the dialog too: the scrim makes the row behind it
    // unreadable.
    const target = node({ id: "node_aaaaaaaaaaaaaaaaaaaaaa", label: "Studio" });
    const twin = node({ id: "node_bbbbbbbbbbbbbbbbbbbbbb", label: "Studio" });
    seedDirectory([target, twin]);
    const revokeNode = vi.spyOn(hostedHubApi, "revokeNode").mockResolvedValue(undefined);
    mounted = await render(<HostedHubRoot />);

    // The first row's details control — both rows are named "Node details:
    // Studio", which is exactly why the dialog cannot rely on the label.
    const details = [
      ...document.querySelectorAll<HTMLElement>('button[aria-label="Node details: Studio"]'),
    ];
    expect(details, "the twin rows did not both render").toHaveLength(2);
    details[0]!.click();

    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    await vi.waitFor(() => {
      expect(revokeDialogText()).toContain("Revoke Studio?");
    });
    // The identifier, in full, is what tells the twins apart.
    expect(revokeDialogText()).toContain(target.id);
    expect(revokeDialogText()).not.toContain(twin.id);

    // Nothing has been sent yet. Opening the confirmation is not the action.
    expect(revokeNode, "the request fired before the confirmation").not.toHaveBeenCalled();

    await page.getByRole("button", { name: "Revoke this node" }).click();
    await vi.waitFor(() => {
      expect(revokeNode).toHaveBeenCalledTimes(1);
    });
    expect(revokeNode.mock.calls[0]?.[0], "it revoked the wrong node").toBe(target.id);
    // The Hub's body schema is strict and `reasonCode` is required.
    expect(revokeNode.mock.calls[0]?.[1]).toMatch(/^[a-z0-9._-]{1,64}$/);
  });

  it("cancels without sending anything", async () => {
    seedDirectory([node()]);
    const revokeNode = vi.spyOn(hostedHubApi, "revokeNode").mockResolvedValue(undefined);
    mounted = await render(<HostedHubRoot />);

    await page.getByRole("button", { name: "Node details: Studio" }).click();
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    await vi.waitFor(() => {
      expect(revokeDialogText()).toContain("Revoke Studio?");
    });
    await page.getByRole("button", { name: "Cancel" }).click();

    await vi.waitFor(() => {
      expect(revokeDialogText()).not.toContain("Revoke Studio?");
    });
    expect(revokeNode).not.toHaveBeenCalled();
    expect(detailsNodeLabels()).toEqual(["Studio"]);
  });

  it("reaches a node that is offline, which is the case it exists for", async () => {
    // Revocation is Hub-side state and contacts nothing on the machine, so a
    // node that is offline, unreachable, or gone for good is revoked by exactly
    // this call. Gating the control on presence would disable it in precisely
    // the situation an owner reaches for it.
    const offline = node({
      presence: { online: false, lastHeartbeatAt: NOW - 86_400_000 },
      lastAuthenticatedAt: NOW - 86_400_000,
    });
    seedDirectory([offline]);
    const revokeNode = vi.spyOn(hostedHubApi, "revokeNode").mockResolvedValue(undefined);
    const listNodes = vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([]);
    mounted = await render(<HostedHubRoot />);

    await page.getByRole("button", { name: "Node details: Studio" }).click();
    // The presence claim the sheet renders, so the assertion below is about an
    // offline node rather than about whatever the fixture happened to be.
    const sheetText =
      document.querySelector<HTMLElement>('[data-slot="sheet-popup"]')?.textContent ?? "";
    expect(sheetText, "the fixture was not offline").not.toContain("Online");

    const revoke = page.getByRole("button", { name: "Revoke", exact: true });
    await expect.element(revoke).toBeEnabled();
    await revoke.click();
    await page.getByRole("button", { name: "Revoke this node" }).click();

    await vi.waitFor(() => {
      expect(revokeNode).toHaveBeenCalledWith(offline.id, expect.any(String));
      expect(listNodes).toHaveBeenCalled();
    });
  });

  it("removes the row on success without a manual refresh", async () => {
    const target = node({ id: "node_aaaaaaaaaaaaaaaaaaaaaa", label: "Studio" });
    const kept = node({ id: "node_bbbbbbbbbbbbbbbbbbbbbb", label: "Travel" });
    seedDirectory([target, kept]);
    vi.spyOn(hostedHubApi, "revokeNode").mockResolvedValue(undefined);
    // A revoked node stops resolving in the Hub's authorized directory entirely,
    // so it does not come back as a revoked row — it is simply absent.
    const listNodes = vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([kept]);
    mounted = await render(<HostedHubRoot />);

    await page.getByRole("button", { name: "Node details: Studio" }).click();
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    await page.getByRole("button", { name: "Revoke this node" }).click();

    await vi.waitFor(() => {
      expect(listNodes).toHaveBeenCalled();
      expect(detailsNodeLabels()).toEqual(["Travel"]);
      // No leftover confirmation and no stranded detail sheet for a node this
      // account can no longer see.
      expect(revokeDialogText()).not.toContain("Revoke Studio?");
      expect(document.querySelector('[data-slot="sheet-popup"]')).toBeNull();
    });
  });

  it("keeps the row standing when the revoke is refused, and says so", async () => {
    // An optimistic removal that silently reverts is worse than a spinner: a row
    // that vanishes and returns is indistinguishable from a partial success.
    const target = node({ id: "node_aaaaaaaaaaaaaaaaaaaaaa", label: "Studio" });
    const kept = node({ id: "node_bbbbbbbbbbbbbbbbbbbbbb", label: "Travel" });
    seedDirectory([target, kept]);
    vi.spyOn(hostedHubApi, "revokeNode").mockRejectedValue(new HostedHubApiError("forbidden", 403));
    // The honest answer for a refusal: the Hub changed nothing, so a re-read
    // would still list both. Mocked that way on purpose — if this shipped an
    // optimistic removal, only the assertions below could catch it, not a
    // fixture that happened to drop the row.
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([target, kept]);
    mounted = await render(<HostedHubRoot />);

    await page.getByRole("button", { name: "Node details: Studio" }).click();
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    await page.getByRole("button", { name: "Revoke this node" }).click();

    await expect.element(page.getByRole("alert")).toHaveTextContent(/Only an owner of this Hub/);
    // Bounded: it says what happened and nothing about the transport.
    const alert = document.querySelector<HTMLElement>('[role="alert"]')?.textContent ?? "";
    expect(alert).toContain("Nothing was changed");
    expect(alert).not.toMatch(/403|forbidden|\/api\//);

    // The node is still there and the confirmation still names it, so the owner
    // is not left reading an error over a list the error does not match.
    //
    // Asserted PAST the 240ms exit transition and against a popup that is not
    // in `data-ending-style`. Read synchronously, these two lines could not tell
    // an open dialog from one Base UI was midway through unmounting, so a
    // `finally { onOpenChange(false) }` in the dialog's submit — dismissing the
    // owner's only account of a refused irreversible action — left the whole
    // file green.
    await settleDialogTransition();
    expect(detailsNodeLabels()).toEqual(["Studio", "Travel"]);
    expect(stayingOpenDialogText(), "the confirmation was dismissed on failure").toContain(
      "Revoke Studio?",
    );
    expect(stayingOpenDialogText()).toContain("Nothing was changed");
    await expect.element(page.getByRole("button", { name: "Revoke this node" })).toBeEnabled();
  });

  it("withdraws the retry when the Hub says the node is already gone", async () => {
    // The Hub's update is conditioned on the node not already being revoked, so
    // a second attempt answers 404 forever. Leaving the button there — enabled
    // or greyed — invites an owner to keep pressing a control whose every
    // attempt is the same refusal, and to hunt for the state that revives it.
    seedDirectory([node()]);
    vi.spyOn(hostedHubApi, "revokeNode").mockRejectedValue(new HostedHubApiError("not_found", 404));
    mounted = await render(<HostedHubRoot />);

    await page.getByRole("button", { name: "Node details: Studio" }).click();
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    await page.getByRole("button", { name: "Revoke this node" }).click();

    await expect.element(page.getByRole("alert")).toHaveTextContent(/nothing here left to revoke/);
    await expect
      .element(page.getByRole("button", { name: "Revoke this node" }))
      .not.toBeInTheDocument();
    // And the escape stops offering to "cancel" something that already resolved.
    // It is not named "Close" either — the dialog primitive's own icon control
    // already owns that name, and two buttons sharing one name in one dialog is
    // the same ambiguity as two rows sharing one.
    await expect.element(page.getByRole("button", { name: "Back to the list" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(
      [...document.querySelectorAll<HTMLElement>('[data-slot="dialog-popup"] button')].filter(
        (button) => (button.getAttribute("aria-label") ?? button.textContent)?.trim() === "Close",
      ),
      "two controls in one dialog answer to the same name",
    ).toHaveLength(1);
  });

  it("does not re-arm the confirmation over a node the owner never chose", async () => {
    // The confirmation's open state used to be a bare `useState(false)` on the
    // detail sheet, cleared only by the Sheet's own `onOpenChange`. But `node`
    // is re-resolved from the store every render, and when the 20-second poll
    // drops the node the sheet is about — another session revoked it, the grant
    // was removed — `HostedNodeDetail` returns null WITHOUT the Sheet primitive
    // ever firing. The flag survived, and the next node the owner opened
    // inherited it: a fully-armed "Revoke <that node>?" they never asked for,
    // one click from revoking the wrong machine.
    const target = node({ id: "node_aaaaaaaaaaaaaaaaaaaaaa", label: "Studio" });
    const other = node({ id: "node_bbbbbbbbbbbbbbbbbbbbbb", label: "Travel" });
    seedDirectory([target, other]);
    const revokeNode = vi.spyOn(hostedHubApi, "revokeNode").mockResolvedValue(undefined);
    mounted = await render(<HostedHubRoot />);

    await page.getByRole("button", { name: "Node details: Studio" }).click();
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    await vi.waitFor(() => {
      expect(revokeDialogText()).toContain("Revoke Studio?");
    });

    // The poll replaces the directory and the confirmation's node is not in it.
    useHostedHubStore.setState({ nodes: [other] });
    await vi.waitFor(() => {
      expect(document.querySelector('[data-slot="dialog-popup"]')).toBeNull();
    });

    // The owner now opens a DIFFERENT machine.
    await page.getByRole("button", { name: "Node details: Travel" }).click();
    await settleDialogTransition();
    expect(revokeDialogText(), "the confirmation re-armed over another node").not.toContain(
      "Revoke Travel?",
    );
    expect(revokeNode).not.toHaveBeenCalled();
  });

  it("keeps the confirmation up and the refusal reachable when escape is pressed mid-flight", async () => {
    // The dialog signalled "busy" twice — no close button, disabled Cancel — but
    // neither reaches Base UI's escape handling. Pressing it while the POST was
    // in flight closed the dialog and left the request running, so the Hub's
    // refusal landed on a component nobody could see: no account whatsoever of a
    // refused irreversible action, and a row that simply stayed.
    seedDirectory([node()]);
    let rejectRevoke: (cause: unknown) => void = () => {};
    vi.spyOn(hostedHubApi, "revokeNode").mockReturnValue(
      new Promise<void>((_resolve, reject) => {
        rejectRevoke = reject;
      }),
    );
    mounted = await render(<HostedHubRoot />);

    await page.getByRole("button", { name: "Node details: Studio" }).click();
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    await page.getByRole("button", { name: "Revoke this node" }).click();
    await vi.waitFor(() => {
      expect(revokeDialogText()).toContain("Revoking…");
    });

    await userEvent.keyboard("{Escape}");
    await settleDialogTransition();
    expect(stayingOpenDialogText(), "escape dismissed an in-flight confirmation").toContain(
      "Revoke Studio?",
    );

    rejectRevoke(new HostedHubApiError("forbidden", 403));
    await expect.element(page.getByRole("alert")).toHaveTextContent(/Only an owner of this Hub/);
  });

  it("sends exactly one request when the owner clicks the confirmation twice", async () => {
    // The busy presentation and the double-submit guard were both unpinned:
    // deleting `if (pending) return` AND `disabled={pending}` together left every
    // test in this file green. Two POSTs mean the second answers 404, so the
    // owner's last sight of a revocation that SUCCEEDED is "there is nothing
    // here left to revoke" with the retry withdrawn.
    seedDirectory([node()]);
    let resolveRevoke: () => void = () => {};
    const revokeNode = vi.spyOn(hostedHubApi, "revokeNode").mockReturnValue(
      new Promise<void>((resolve) => {
        resolveRevoke = resolve;
      }),
    );
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([]);
    mounted = await render(<HostedHubRoot />);

    await page.getByRole("button", { name: "Node details: Studio" }).click();
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    const confirm = page.getByRole("button", { name: "Revoke this node" });
    await confirm.click();

    // The control says it is busy and refuses to be pressed again.
    await expect.element(page.getByRole("button", { name: "Revoking…" })).toBeDisabled();
    expect(revokeDialogText()).not.toContain("Revoke this node");

    // …and pressing anyway — a real double-click lands before the disable
    // paints — sends nothing more.
    document
      .querySelectorAll<HTMLElement>('[data-slot="dialog-popup"] button')
      .forEach((button) => {
        if (button.textContent?.trim() === "Revoking…") button.click();
      });
    await settleDialogTransition();
    expect(revokeNode, "a second irreversible write went out").toHaveBeenCalledTimes(1);

    resolveRevoke();
    await vi.waitFor(() => {
      expect(revokeNode).toHaveBeenCalledTimes(1);
      expect(document.querySelector('[data-slot="dialog-popup"]')).toBeNull();
    });
  });

  it("says the revocation landed even when the follow-up re-read fails", async () => {
    // `refreshDirectory` cannot reject: its own catch settles into
    // `directoryStatus: "stale"` and leaves `nodes` UNTOUCHED. So a Hub restart
    // in the second after an irreversible commit left the owner looking at the
    // same list, with the row still on it and still un-revoked, and not one word
    // saying the revocation happened — indistinguishable from a dismissed
    // dialog. The acknowledgement is driven by `revokeNode` resolving instead.
    const target = node({ id: "node_aaaaaaaaaaaaaaaaaaaaaa", label: "Studio" });
    const kept = node({ id: "node_bbbbbbbbbbbbbbbbbbbbbb", label: "Travel" });
    seedDirectory([target, kept]);
    vi.spyOn(hostedHubApi, "revokeNode").mockResolvedValue(undefined);
    vi.spyOn(hostedHubApi, "listNodes").mockRejectedValue(new Error("the Hub restarted"));
    mounted = await render(<HostedHubRoot />);

    await page.getByRole("button", { name: "Node details: Studio" }).click();
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    await page.getByRole("button", { name: "Revoke this node" }).click();

    // Named, because "a node was revoked" over a list of near-identical rows is
    // the same ambiguity the confirmation's own title exists to avoid.
    await expect.element(page.getByText(/Studio was revoked/)).toBeVisible();

    await settleDialogTransition();
    // The re-read failed, so the row really is still there — which is exactly
    // the state the notice above has to survive.
    expect(detailsNodeLabels()).toContain("Studio");
    // And the sheet is gone, so there is no live Revoke button left on a machine
    // that has already been revoked. Removing `setDetailNodeId(null)` used to
    // leave every test in this file green, because the mocked re-read always
    // dropped the row and closed the sheet on its own.
    expect(document.querySelector('[data-slot="sheet-popup"]')).toBeNull();
    expect(revokeDialogText()).not.toContain("Revoke Studio?");
  });

  it("does not offer revocation to an operator or a viewer", async () => {
    for (const role of ["operator", "viewer"] as const) {
      useHostedHubStore.setState({
        accountStatus: "authenticated",
        account: { ...account, role },
        session,
        directoryStatus: "ready",
        browserStatus: "current",
        nodes: [node()],
      });
      mounted = await render(<HostedHubRoot />);
      await page.getByRole("button", { name: "Node details: Studio" }).click();
      await expect
        .element(page.getByRole("button", { name: "Revoke", exact: true }))
        .not.toBeInTheDocument();

      await mounted.unmount();
      mounted = null;
      hostedHubController.resetForTests();
      resetDirectoryRouteForTests();
    }
  });

  it("does not offer a second revocation for a node that already carries one", async () => {
    // The Hub's update is conditioned on the node not already being revoked, so
    // a second attempt is a 404 and nothing else. The detail sheet still opens —
    // that is what it is for — and already says the access was revoked.
    seedDirectory([node({ revokedAt: NOW, revocationReasonCode: "administrative" })]);
    mounted = await render(<HostedHubRoot />);

    await page.getByRole("button", { name: "Node details: Studio" }).click();
    await expect.element(page.getByText("Access to this node was revoked.")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Revoke", exact: true }))
      .not.toBeInTheDocument();
  });

  it("claims nothing about the machine itself in the copy it renders", async () => {
    // The scan runs over the RENDERED text rather than over the logic module's
    // exports, so a literal written straight into the `.tsx` is covered without
    // waiting for someone to move it. Every token below would describe an effect
    // on the node that revocation does not have — and a bare substring match
    // cannot tell a claim from its denial, so the words are absent either way.
    seedDirectory([node()]);
    mounted = await render(<HostedHubRoot />);
    await page.getByRole("button", { name: "Node details: Studio" }).click();
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    await vi.waitFor(() => {
      expect(revokeDialogText()).toContain("Revoke Studio?");
    });

    const rendered = revokeDialogText().toLowerCase();
    for (const phrase of [
      "notif",
      "wipe",
      "erase",
      "delete",
      "uninstall",
      "factory reset",
      "shut down",
      "shutdown",
      "power off",
      "disk",
      "local data",
      "its files",
      "tells the node",
      "informs the node",
      "let the node know",
      "restore",
      "re-enable",
      "reinstate",
    ]) {
      expect(rendered, `the confirmation says ${phrase}`).not.toContain(phrase);
    }

    // And it does say the four things that are true.
    expect(rendered).toContain("everyone");
    expect(rendered).toContain("enroll");
    expect(rendered).toContain("offline");
    expect(rendered).toContain("hub");
  });
});

describe("account settings reachability", () => {
  it("reaches account security from the node directory, with no node at all", async () => {
    // Regression, in its new shape. `LazySettingsDialogMount` used to be
    // rendered from exactly one place — inside `RootAppShell`, which the hosted
    // root only reaches once a relay session is live — so an account with zero
    // nodes, only offline nodes, or only revoked ones could not open account
    // settings at all: `openSettings` is a global singleton and flipped
    // silently against no mount.
    //
    // Account management is a Hub page now, so the reachability that used to
    // depend on a dialog host being mounted is a navigation, and the surface it
    // lands on renders with no node present.
    seedDirectory([]);
    mounted = await render(<HostedHubRoot />);

    await page.getByRole("button", { name: "Account settings" }).click();

    await expect.element(page.getByRole("heading", { name: "Account", level: 1 })).toBeVisible();
    expect(window.location.pathname).toBe("/account/security");
    // The node app's settings dialog is not what opened.
    expect(useSettingsDialogStore.getState().open).toBe(false);
    expect(document.querySelector('[data-slot="dialog-popup"]')).toBeNull();
  });

  it("mounts no settings dialog host on a Hub surface", async () => {
    // The Hub used to carry a second `LazySettingsDialogMount` so node-less
    // surfaces could open account settings. Nothing on a Hub page opens that
    // dialog now, so the mount is gone and the invariant is simply that one
    // host exists — in `AppSidebarLayout`, inside a node session.
    seedDirectory([node()]);
    mounted = await render(<HostedHubRoot />);
    useSettingsDialogStore.setState({ open: true, section: "account" });

    await expect.element(page.getByRole("heading", { name: /Your node/ })).toBeVisible();
    expect(
      document.querySelectorAll('[data-slot="dialog-popup"]'),
      "a Hub surface rendered the node app's settings dialog",
    ).toHaveLength(0);
  });

  it("keeps an unrelated terminal relay failure local while account settings stay reachable", async () => {
    const selected = node();
    seedDirectory([selected], {
      selectedNode: selected,
      transportStatus: "terminal-failure",
      errorMessage: "The relay authentication attempt expired or was rejected.",
    });
    mounted = await render(<HostedHubRoot />);
    await expect.element(page.getByRole("heading", { name: /Your node/ })).toBeVisible();
    await expect
      .element(page.getByRole("heading", { name: /Unable to connect/ }))
      .not.toBeInTheDocument();

    await page.getByRole("button", { name: "Account settings" }).click();

    await expect.element(page.getByRole("heading", { name: "Account", level: 1 })).toBeVisible();
    expect(window.location.pathname).toBe("/account/security");
  });
});
