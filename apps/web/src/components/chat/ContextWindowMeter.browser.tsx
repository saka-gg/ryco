import "../../index.css";

import {
  AuthRpcError,
  EnvironmentId,
  ProviderInstanceId,
  type ClaudeCacheObservation,
  type CliProxyAccount,
  type CliProxyHubSnapshot,
  type CliProxyReadHubsResult,
  type EnvironmentApi,
  type ServerProviderRateLimits,
} from "@ryco/contracts";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { deriveContextWindowUsage } from "../../lib/contextWindow";
import { syncDocumentPresentationTier } from "../../lib/presentationTier";
import { defaultQueryClient } from "../../rpc/queryClient";
import { cliProxyHubsQueryKey } from "../usage/cliProxyHubsQuery";
import { type ContextWindowAccount, ContextWindowMeter } from "./ContextWindowMeter";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));

const environmentId = EnvironmentId.make("env-composer");
const instanceId = ProviderInstanceId.make("claude_hub");
// Local limits of an instance routed through a hub describe no account the hub uses.
const localRateLimits: ServerProviderRateLimits = {
  primary: { usedPercent: 3 },
};

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function hubAccount(
  overrides: Partial<CliProxyAccount> & Pick<CliProxyAccount, "authIndex">,
): CliProxyAccount {
  return {
    provider: "claude",
    name: `${overrides.authIndex}.json`,
    status: "active",
    disabled: false,
    unavailable: false,
    cooldowns: [],
    requests: { success: 0, failed: 0, recent: [] },
    quota: { status: "ok", windows: [] },
    ...overrides,
  };
}

function hub(
  routedInstanceIds: ProviderInstanceId[],
  overrides: Partial<CliProxyHubSnapshot> = {},
): CliProxyHubSnapshot {
  const fiveHour = (usedPercent: number) => ({
    id: "five_hour",
    usedPercent,
    windowDurationMins: 300,
  });
  return {
    hubId: "home" as CliProxyHubSnapshot["hubId"],
    label: "Home hub",
    url: "http://127.0.0.1:8317",
    checkedAt: new Date().toISOString(),
    status: "ok",
    accounts: [
      hubAccount({
        authIndex: "a",
        email: "current@example.com",
        lastUsedAt: minutesAgo(1),
        quota: {
          status: "ok",
          planType: "max",
          checkedAt: new Date().toISOString(),
          windows: [fiveHour(42)],
        },
      }),
      hubAccount({
        authIndex: "b",
        email: "other@example.com",
        lastUsedAt: minutesAgo(4),
        quota: { status: "ok", windows: [fiveHour(10)] },
      }),
    ],
    apiKeys: [],
    routedInstanceIds,
    ...overrides,
  };
}

function account(overrides: Partial<ContextWindowAccount> = {}) {
  return {
    environmentId,
    instanceId,
    displayName: "Claude Hub",
    label: "Claude Max Subscription",
    email: "me@example.com",
    checkCliProxyRoute: true,
    ...overrides,
  } satisfies ContextWindowAccount;
}

async function open() {
  await page.getByRole("button", { name: /Context window/ }).click();
  await expect.element(page.getByText("Context window", { exact: true })).toBeVisible();
}

// Escape does not close the popup again after a reopen in this harness; an outside press does.
async function close() {
  await userEvent.click(document.body, { position: { x: 1_000, y: 5 } });
  await expect.element(page.getByText("Context window", { exact: true })).not.toBeInTheDocument();
}

async function reopen() {
  await close();
  await open();
}

/** Reopens once the last read is older than the reuse window, here by marking it stale. */
async function reopenAfterReuseWindow() {
  await close();
  await defaultQueryClient.invalidateQueries({ queryKey: cliProxyHubsQueryKey(environmentId) });
  await open();
}

function serveHubs(read: () => Promise<CliProxyReadHubsResult>) {
  const readCliProxyHubs = vi.fn(read);
  __setEnvironmentApiOverrideForTests(environmentId, {
    server: { readCliProxyHubs },
  } as unknown as EnvironmentApi);
  return readCliProxyHubs;
}

/** Whether `element` stays within the popup's inline content inset. */
function insidePopupContent(element: Element): boolean {
  const viewport = document.querySelector('[data-slot="popover-viewport"]')!;
  const style = getComputedStyle(viewport);
  const bounds = viewport.getBoundingClientRect();
  const box = element.getBoundingClientRect();
  return (
    box.left >= bounds.left + Number.parseFloat(style.paddingLeft) - 0.5 &&
    box.right <= bounds.right - Number.parseFloat(style.paddingRight) + 0.5
  );
}

describe("ContextWindowMeter account details", () => {
  let mounted: Awaited<ReturnType<typeof render>> | null = null;
  let stopTierSync: (() => void) | null = null;

  beforeEach(async () => {
    await page.viewport(1_280, 800);
    stopTierSync = syncDocumentPresentationTier();
  });

  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    stopTierSync?.();
    stopTierSync = null;
    __resetEnvironmentApiOverridesForTests();
    defaultQueryClient.clear();
    navigate.mockReset();
    document.body.innerHTML = "";
  });

  it("re-renders an open popup when a relative label changes, not every second", async () => {
    // A cache read that turns from "3m ago" into "4m ago" about 2.5 s after the popup opens,
    // and a reset whose label holds for another 30 s.
    const observedAt = new Date(Date.now() - 240_000 + 2_500).toISOString();
    let commits = 0;
    mounted = await render(
      <Profiler id="meter" onRender={() => (commits += 1)}>
        <ContextWindowMeter
          usage={deriveContextWindowUsage([], "200k")}
          rateLimits={{ primary: { usedPercent: 3, resetsAt: Date.now() / 1000 + 7_230 } }}
          claudeCache={
            {
              source: "assistant-usage",
              observedAt,
              messageId: "message-1",
              cacheReadInputTokens: 1_000,
              cacheWriteInputTokens: 100,
              directInputTokens: 10,
            } as unknown as ClaudeCacheObservation
          }
          available
          account={account({ checkCliProxyRoute: false })}
        />
      </Profiler>,
    );
    await open();
    await expect.element(page.getByText("Last request 3m ago", { exact: false })).toBeVisible();

    // A second-by-second tick would commit here; the labels have not changed yet.
    const settled = commits;

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(commits).toBe(settled);

    // It re-renders once the label does.
    await expect
      .element(page.getByText("Last request 4m ago", { exact: false }))
      .toBeVisible();
    expect(commits - settled).toBeLessThanOrEqual(2);
  });

  it("names the instance and its login with the email blurred", async () => {
    mounted = await render(
      <ContextWindowMeter
        usage={deriveContextWindowUsage([], "200k")}
        rateLimits={localRateLimits}
        available
        account={account({ checkCliProxyRoute: false })}
      />,
    );
    await open();

    await expect.element(page.getByText("Account", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Claude Hub", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Claude Max Subscription")).toBeVisible();
    const email = page.getByRole("button", { name: "Toggle account email visibility" });
    await expect.element(email).toBeVisible();
    await expect.element(email).not.toHaveTextContent("me@example.com");
    await expect.element(page.getByText("Short window", { exact: true })).toBeVisible();
  });

  it("keeps realistic and long emails inside the popup", async () => {
    const usage = deriveContextWindowUsage([], "200k");
    mounted = await render(
      <ContextWindowMeter
        usage={usage}
        available
        account={account({ checkCliProxyRoute: false, email: "first.lastname@example.com" })}
      />,
    );
    await open();
    const email = page.getByRole("button", { name: "Toggle account email visibility" });
    await expect.element(email).toBeVisible();
    expect(insidePopupContent(email.element())).toBe(true);
    // The plan label keeps its full width instead of being squeezed by the email.
    const label = page.getByText("Claude Max Subscription").element();
    expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth);

    await mounted.rerender(
      <ContextWindowMeter
        usage={usage}
        available
        account={account({
          checkCliProxyRoute: false,
          email: "a.very.long.mailbox.name.for.testing@subdomain.example.com",
        })}
      />,
    );
    await email.click();
    await expect
      .element(email)
      .toHaveTextContent("a.very.long.mailbox.name.for.testing@subdomain.example.com");
    expect(insidePopupContent(email.element())).toBe(true);
  });

  it("shows the hub's last account and quota instead of the instance's own limits", async () => {
    const readCliProxyHubs = serveHubs(async () => ({ hubs: [hub([instanceId])] }));
    mounted = await render(
      <ContextWindowMeter
        usage={deriveContextWindowUsage([], "200k")}
        rateLimits={localRateLimits}
        available
        account={account()}
      />,
    );
    await open();

    await expect.element(page.getByText("Via CLIProxyAPI · Home hub")).toBeVisible();
    await expect.element(page.getByText("Last request:")).toBeVisible();
    await expect.element(page.getByText("· Max · 1m ago")).toBeVisible();
    await expect.element(page.getByText("Rotating across 2 accounts")).toBeVisible();
    await expect.element(page.getByText("42% used")).toBeVisible();
    await expect.element(page.getByText(/Pool of 2 accounts: 5h 26% used/)).toBeVisible();
    expect(document.body.textContent).not.toContain("current@example.com");
    expect(document.body.textContent).not.toContain("Short window");

    await page.getByRole("button", { name: "All accounts" }).click();
    expect(navigate).toHaveBeenCalledWith({
      to: "/statistics",
      search: expect.objectContaining({ view: "limits", environmentIds: [environmentId] }),
    });

    // Reopening within the reuse window shows the last read without asking the node again.
    await reopen();
    await expect.element(page.getByText("Via CLIProxyAPI · Home hub")).toBeVisible();
    expect(readCliProxyHubs).toHaveBeenCalledOnce();
  });

  it("shows a compact loading line until the hub read lands", async () => {
    let resolveRead: (result: CliProxyReadHubsResult) => void = () => undefined;
    serveHubs(
      () =>
        new Promise<CliProxyReadHubsResult>((resolve) => {
          resolveRead = resolve;
        }),
    );
    mounted = await render(
      <ContextWindowMeter
        usage={deriveContextWindowUsage([], "200k")}
        available
        account={account()}
      />,
    );
    await open();

    await expect.element(page.getByText("Checking CLIProxyAPI hubs…")).toBeVisible();
    resolveRead({ hubs: [hub([instanceId])] });
    await expect.element(page.getByText("Via CLIProxyAPI · Home hub")).toBeVisible();
    await expect.element(page.getByText("Checking CLIProxyAPI hubs…")).not.toBeInTheDocument();
  });

  it("reports a routed hub that could not be read and an account whose quota failed", async () => {
    const failedQuota = hubAccount({
      authIndex: "a",
      email: "current@example.com",
      lastUsedAt: minutesAgo(1),
      quota: { status: "failed", message: "Anthropic returned 429.", windows: [] },
    });
    const responses = [
      { hubs: [hub([instanceId], { status: "error", error: "The hub is unreachable." })] },
      { hubs: [hub([instanceId], { accounts: [failedQuota] })] },
    ];
    serveHubs(async () => responses.shift()!);
    mounted = await render(
      <ContextWindowMeter
        usage={deriveContextWindowUsage([], "200k")}
        rateLimits={localRateLimits}
        available
        account={account()}
      />,
    );
    await open();

    await expect.element(page.getByText("Via CLIProxyAPI · Home hub")).toBeVisible();
    await expect.element(page.getByText("The hub is unreachable.")).toBeVisible();
    expect(document.body.textContent).not.toContain("Short window");

    await reopenAfterReuseWindow();
    await expect.element(page.getByText("Anthropic returned 429.")).toBeVisible();
    await expect.element(page.getByText("Last request:")).toBeVisible();
  });

  it("keeps the instance's own limits when no hub routes it", async () => {
    serveHubs(async () => ({ hubs: [hub([])] }));
    mounted = await render(
      <ContextWindowMeter
        usage={deriveContextWindowUsage([], "200k")}
        rateLimits={localRateLimits}
        available
        account={account()}
      />,
    );
    await open();

    await expect.element(page.getByText("Short window", { exact: true })).toBeVisible();
    await vi.waitFor(() => expect(document.body.textContent).not.toContain("Checking"));
    expect(document.body.textContent).not.toContain("Via CLIProxyAPI");
  });

  it("leaves the frozen phone tier without account details or hub reads", async () => {
    await page.viewport(390, 844);
    const readCliProxyHubs = serveHubs(async () => ({ hubs: [hub([instanceId])] }));
    mounted = await render(
      <ContextWindowMeter
        usage={deriveContextWindowUsage([], "200k")}
        rateLimits={localRateLimits}
        available
        account={account()}
      />,
    );
    await open();

    await expect.element(page.getByText("Short window", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Account", { exact: true })).not.toBeVisible();
    expect(readCliProxyHubs).not.toHaveBeenCalled();
  });

  it("treats a session the node refuses hub reads as having no hubs", async () => {
    const readCliProxyHubs = serveHubs(async () => {
      throw new AuthRpcError({
        message: "Only owner sessions can call server.readCliProxyHubs.",
        status: 403,
      });
    });
    mounted = await render(
      <ContextWindowMeter
        usage={deriveContextWindowUsage([], "200k")}
        rateLimits={localRateLimits}
        available
        account={account()}
      />,
    );
    await open();

    await expect.element(page.getByText("Short window", { exact: true })).toBeVisible();
    await vi.waitFor(() => expect(document.body.textContent).not.toContain("Checking"));
    expect(document.body.textContent).not.toContain("Couldn't read CLIProxyAPI hubs");
    // The answer is reused like any other read instead of asking again on every open.
    await reopen();
    expect(readCliProxyHubs).toHaveBeenCalledOnce();
  });

  it("blurs a last account named after its email", async () => {
    serveHubs(async () => ({
      hubs: [
        hub([instanceId], {
          accounts: [
            hubAccount({
              authIndex: "a",
              name: "claude-current@example.com.json",
              lastUsedAt: minutesAgo(1),
            }),
          ],
        }),
      ],
    }));
    mounted = await render(
      <ContextWindowMeter
        usage={deriveContextWindowUsage([], "200k")}
        available
        account={account({ email: undefined })}
      />,
    );
    await open();

    await expect.element(page.getByText("Last request:")).toBeVisible();
    expect(document.body.textContent).not.toContain("current@example.com");
  });

  it("reports a failed hub read inline, drops the earlier hubs and retries on the next open", async () => {
    let failing = false;
    const readCliProxyHubs = serveHubs(async () => {
      if (failing) throw new Error("This action is unavailable for your role.");
      return { hubs: [hub([instanceId])] };
    });
    mounted = await render(
      <ContextWindowMeter
        usage={deriveContextWindowUsage([], "200k")}
        available
        account={account()}
      />,
    );
    await open();
    await expect.element(page.getByText("Via CLIProxyAPI · Home hub")).toBeVisible();

    failing = true;
    await reopenAfterReuseWindow();
    await expect
      .element(
        page.getByText("Couldn't read CLIProxyAPI hubs: This action is unavailable for your role."),
      )
      .toBeVisible();
    expect(document.body.textContent).not.toContain("Via CLIProxyAPI");

    await reopen();
    await vi.waitFor(() => expect(readCliProxyHubs).toHaveBeenCalledTimes(3));
  });
});
