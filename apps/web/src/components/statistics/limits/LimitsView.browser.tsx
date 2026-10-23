import "../../../index.css";

import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type CliProxyAccount,
  type CliProxyApiKeyUsage,
  type CliProxyHubSnapshot,
  type ServerProvider,
} from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { parseStatisticsSearch, type StatisticsSearch } from "../statisticsSearch";
import { LimitsView } from "./LimitsView";
import type { UseSubscriptionLimitsResult } from "./useSubscriptionLimits";

const harness = vi.hoisted(() => ({
  result: null as UseSubscriptionLimitsResult | null,
}));

vi.mock("./useSubscriptionLimits", () => ({
  useSubscriptionLimits: () => harness.result,
}));

const desktop = EnvironmentId.make("env-limits");
const ssh = EnvironmentId.make("env-ssh");
const checkedAt = new Date().toISOString();

function account(overrides: Partial<CliProxyAccount> = {}): CliProxyAccount {
  return {
    authIndex: "a",
    provider: "claude",
    name: "claude-a.json",
    status: "active",
    disabled: false,
    unavailable: false,
    cooldowns: [],
    requests: { success: 1, failed: 0, recent: [] },
    quota: { status: "ok", checkedAt, windows: [] },
    ...overrides,
  };
}

function loopbackHub(
  accounts: CliProxyAccount[],
  apiKeys: CliProxyApiKeyUsage[] = [],
): CliProxyHubSnapshot {
  return {
    hubId: "cliproxy-127-0-0-1-8317" as CliProxyHubSnapshot["hubId"],
    label: "127.0.0.1:8317",
    url: "http://127.0.0.1:8317",
    checkedAt,
    status: "ok",
    accounts,
    apiKeys,
    routedInstanceIds: [],
  };
}

type EnvironmentInput = Omit<
  UseSubscriptionLimitsResult["environments"][number],
  "connected" | "providers"
> &
  Partial<Pick<UseSubscriptionLimitsResult["environments"][number], "connected" | "providers">>;

function serve(
  environments: ReadonlyArray<EnvironmentInput>,
  availableEnvironments: UseSubscriptionLimitsResult["availableEnvironments"] = environments,
) {
  harness.result = {
    availableEnvironments,
    environments: environments.map((environment) => ({
      connected: true,
      providers: [],
      ...environment,
    })),
    loading: false,
    refreshing: false,
    receivedAtMs: Date.now(),
    refresh: () => undefined,
  };
}

function provider(
  overrides: Partial<ServerProvider> & Pick<ServerProvider, "instanceId">,
): ServerProvider {
  return {
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

const codex = provider({
  instanceId: ProviderInstanceId.make("codex"),
  displayName: "Codex",
  auth: { status: "authenticated", email: "direct.person@example.com" },
  rateLimits: {
    planType: "pro",
    primary: { usedPercent: 23, windowDurationMins: 300 },
    secondary: { usedPercent: 61, windowDurationMins: 10_080 },
  },
});

const apiKey = (keyHint: string): CliProxyApiKeyUsage => ({
  provider: "claude",
  keyHint,
  requests: { success: 1, failed: 0, recent: [] },
});

describe("LimitsView", () => {
  let mounted: Awaited<ReturnType<typeof render>> | null = null;
  const onSearchChange = vi.fn<(next: StatisticsSearch) => void>();
  // A new element each time, so a rerender renders again instead of bailing out on equal props.
  const view = () => (
    <LimitsView
      search={parseStatisticsSearch({ view: "limits" })}
      onSearchChange={onSearchChange}
    />
  );

  beforeEach(() => {
    onSearchChange.mockReset();
    serve([
      {
        environmentId: desktop,
        label: "This machine",
        status: "ok",
        hubs: [
          {
            ...loopbackHub([account({ email: "first.lastname@example.com" })]),
            hubId: "home" as CliProxyHubSnapshot["hubId"],
          },
        ],
      },
    ]);
  });

  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    document.body.innerHTML = "";
  });

  it("blurs account emails until clicked", async () => {
    mounted = await render(
      <LimitsView
        search={parseStatisticsSearch({ view: "limits" })}
        onSearchChange={onSearchChange}
      />,
    );

    const email = page.getByRole("button", { name: "Toggle account email visibility" });
    await expect.element(email).toBeVisible();
    expect(document.body.textContent).not.toContain("first.lastname@example.com");

    await email.click();
    await expect.element(email).toHaveTextContent("first.lastname@example.com");
  });

  it("blurs a credential file name that carries the account email", async () => {
    serve([
      {
        environmentId: desktop,
        label: "This machine",
        status: "ok",
        hubs: [loopbackHub([account({ name: "claude-first.lastname@example.com.json" })])],
      },
    ]);
    mounted = await render(
      <LimitsView
        search={parseStatisticsSearch({ view: "limits" })}
        onSearchChange={onSearchChange}
      />,
    );

    await expect
      .element(page.getByRole("button", { name: "Toggle account email visibility" }))
      .toBeVisible();
    expect(document.body.textContent).not.toContain("first.lastname@example.com");
  });

  it("keeps each node's loopback hub apart and names its node", async () => {
    serve([
      {
        environmentId: desktop,
        label: "This machine",
        status: "ok",
        hubs: [loopbackHub([account({ email: "desk@example.com" })], [apiKey("…a1a1")])],
      },
      {
        environmentId: ssh,
        label: "Build box",
        status: "ok",
        hubs: [loopbackHub([account({ email: "ssh@example.com" })], [apiKey("…b2b2")])],
      },
    ]);
    mounted = await render(
      <LimitsView
        search={parseStatisticsSearch({ view: "limits" })}
        onSearchChange={onSearchChange}
      />,
    );

    await expect.element(page.getByText("…a1a1")).toBeVisible();
    await expect.element(page.getByText("…b2b2")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Toggle account email visibility" }).nth(1))
      .toBeVisible();
    await expect.element(page.getByText("127.0.0.1:8317 · Build box").first()).toBeVisible();
  });

  it("shows the environment filter it applies and clears it", async () => {
    serve(
      [
        {
          environmentId: desktop,
          label: "This machine",
          status: "ok",
          hubs: [loopbackHub([account()])],
        },
      ],
      [
        { environmentId: desktop, label: "This machine" },
        { environmentId: ssh, label: "Build box" },
      ],
    );
    mounted = await render(
      <LimitsView
        search={parseStatisticsSearch({ view: "limits", environmentIds: [desktop] })}
        onSearchChange={onSearchChange}
      />,
    );

    const filter = page.getByRole("combobox", { name: "Limits environment" });
    await expect.element(filter).toHaveTextContent("This machine");
    await filter.click();
    await page.getByRole("option", { name: "All environments" }).click();
    expect(onSearchChange).toHaveBeenCalledWith(
      expect.objectContaining({ view: "limits", environmentIds: undefined }),
    );
  });

  it("asks to update a node that predates hubs", async () => {
    serve([
      {
        environmentId: ssh,
        label: "Build box",
        status: "unsupported",
        hubs: [],
        message: "Update Ryco on this node to read CLIProxyAPI hubs.",
      },
    ]);
    mounted = await render(
      <LimitsView
        search={parseStatisticsSearch({ view: "limits" })}
        onSearchChange={onSearchChange}
      />,
    );

    await expect
      .element(page.getByText("Update Ryco on this node to read CLIProxyAPI hubs."))
      .toBeVisible();
  });

  it("shows direct accounts without a hub and offers to connect one", async () => {
    serve([
      { environmentId: desktop, label: "This machine", status: "ok", hubs: [], providers: [codex] },
    ]);
    mounted = await render(
      <LimitsView
        search={parseStatisticsSearch({ view: "limits" })}
        onSearchChange={onSearchChange}
      />,
    );

    await expect.element(page.getByText("1 account · 1 direct", { exact: false })).toBeVisible();
    await expect.element(page.getByText("Direct", { exact: true })).toBeVisible();
    await expect.element(page.getByText("23% used")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Connect a hub" })).toBeVisible();
    expect(document.body.textContent).not.toContain("direct.person@example.com");
    expect(page.getByRole("radiogroup", { name: "Limit source" }).query()).toBeNull();
  });

  it("shows direct accounts while hubs are still being read", async () => {
    const environment = { environmentId: desktop, label: "This machine", providers: [codex] };
    serve([{ ...environment, status: "loading", hubs: [] }]);
    mounted = await render(view());

    await expect.element(page.getByText("23% used")).toBeVisible();
    await expect.element(page.getByText("reading hubs…", { exact: false })).toBeVisible();
    expect(page.getByRole("button", { name: "Connect a hub" }).query()).toBeNull();
    expect(page.getByRole("alert").query()).toBeNull();

    serve([{ ...environment, status: "ok", hubs: [] }]);
    await mounted.rerender(view());

    await expect.element(page.getByRole("button", { name: "Connect a hub" })).toBeVisible();
    expect(document.body.textContent).not.toContain("reading hubs");
  });

  it("waits for hub reads before saying there is nothing to show", async () => {
    const environment = { environmentId: desktop, label: "This machine" };
    serve([{ ...environment, status: "loading", hubs: [] }]);
    mounted = await render(view());

    expect(document.querySelector(".animate-pulse")).not.toBeNull();
    expect(document.body.textContent).not.toContain("No subscription limits to show");

    serve([{ ...environment, status: "ok", hubs: [] }]);
    await mounted.rerender(view());

    await expect.element(page.getByText("No subscription limits to show")).toBeVisible();
  });

  it("keeps the environment filter mounted while a filter change re-reads hubs", async () => {
    const both = [
      { environmentId: desktop, label: "This machine" },
      { environmentId: ssh, label: "Build box" },
    ];
    const filtered = () => (
      <LimitsView
        search={parseStatisticsSearch({ view: "limits", environmentIds: [ssh] })}
        onSearchChange={onSearchChange}
      />
    );
    serve([{ environmentId: ssh, label: "Build box", status: "loading", hubs: [] }], both);
    mounted = await render(filtered());

    const filter = page.getByRole("combobox", { name: "Limits environment" });
    await expect.element(filter).toBeVisible();
    expect(document.querySelector(".animate-pulse")).not.toBeNull();
    const trigger = filter.element();

    serve([{ environmentId: ssh, label: "Build box", status: "ok", hubs: [] }], both);
    await mounted.rerender(filtered());

    await expect.element(page.getByText("No subscription limits to show")).toBeVisible();
    expect(filter.element()).toBe(trigger);
  });

  it("mixes direct and hub accounts of a provider and filters them by source", async () => {
    const routedClaude = provider({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName: "Claude proxied",
      // A routed instance's own limits describe no account the hub uses.
      rateLimits: { primary: { usedPercent: 99, windowDurationMins: 300 } },
    });
    const directClaude = provider({
      instanceId: ProviderInstanceId.make("claude-personal"),
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName: "Claude personal",
      auth: { status: "authenticated", label: "Claude Max Subscription" },
      rateLimits: { primary: { usedPercent: 90, windowDurationMins: 300 } },
    });
    const hubAccount = (authIndex: string, usedPercent: number) =>
      account({
        authIndex,
        name: `claude-${authIndex}.json`,
        quota: {
          status: "ok",
          checkedAt,
          windows: [{ id: "five_hour", usedPercent, windowDurationMins: 300 }],
        },
      });
    serve([
      {
        environmentId: desktop,
        label: "This machine",
        status: "ok",
        providers: [routedClaude, directClaude],
        hubs: [
          {
            ...loopbackHub([hubAccount("a", 20), hubAccount("b", 40)]),
            routedInstanceIds: [routedClaude.instanceId],
          },
        ],
      },
    ]);
    mounted = await render(
      <LimitsView
        search={parseStatisticsSearch({ view: "limits" })}
        onSearchChange={onSearchChange}
      />,
    );

    await expect.element(page.getByText("1 direct · 2 via hub")).toBeVisible();
    // The pool averages the hub's 20% and 40% only; the direct 90% is never averaged in.
    await expect.element(page.getByText("70% left")).toBeVisible();
    await expect.element(page.getByText("avg of 2 hub accounts")).toBeVisible();
    await expect.element(page.getByText("90% used")).toBeVisible();
    await expect.element(page.getByText("Claude proxied", { exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain("99% used");

    await page.getByRole("radio", { name: "CLIProxyAPI" }).click();
    await expect.element(page.getByText("2 via hub", { exact: true })).toBeVisible();
    // Without direct cards beside it, the hub view reads as it always has.
    await expect.element(page.getByText("avg of 2 accounts")).toBeVisible();
    expect(document.body.textContent).not.toContain("Claude Max Subscription");
    expect(document.body.textContent).not.toContain("Claude proxied");

    await page.getByRole("radio", { name: "Direct" }).click();
    await expect.element(page.getByText("1 direct", { exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain("avg of");
    expect(page.getByRole("heading", { name: "Hubs" }).query()).toBeNull();
  });

  it("counts an account signed in on two nodes once", async () => {
    serve([
      { environmentId: desktop, label: "This machine", status: "ok", hubs: [], providers: [codex] },
      { environmentId: ssh, label: "Build box", status: "ok", hubs: [], providers: [codex] },
    ]);
    mounted = await render(
      <LimitsView
        search={parseStatisticsSearch({ view: "limits" })}
        onSearchChange={onSearchChange}
      />,
    );

    await expect.element(page.getByText("1 account · 1 direct", { exact: false })).toBeVisible();
    await expect.element(page.getByText("signed in on 2 nodes", { exact: false })).toBeVisible();
  });

  it("keeps one email on two plans as two accounts", async () => {
    const team = provider({
      ...codex,
      instanceId: ProviderInstanceId.make("codex-team"),
      displayName: "Codex team",
      rateLimits: { ...codex.rateLimits, planType: "plus" },
    });
    serve([
      {
        environmentId: desktop,
        label: "This machine",
        status: "ok",
        hubs: [],
        providers: [codex, team],
      },
    ]);
    mounted = await render(
      <LimitsView
        search={parseStatisticsSearch({ view: "limits" })}
        onSearchChange={onSearchChange}
      />,
    );

    await expect.element(page.getByText("2 accounts · 2 direct", { exact: false })).toBeVisible();
    await expect.element(page.getByText("Direct", { exact: true }).nth(1)).toBeVisible();
  });

  it("notes a direct account a hub also holds, under every source filter", async () => {
    const directClaude = provider({
      instanceId: ProviderInstanceId.make("claude-personal"),
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName: "Claude personal",
      auth: { status: "authenticated", email: "shared.person@example.com" },
      rateLimits: { primary: { usedPercent: 40, windowDurationMins: 300 } },
    });
    serve([
      {
        environmentId: desktop,
        label: "This machine",
        status: "ok",
        providers: [directClaude],
        hubs: [loopbackHub([account({ email: "Shared.Person@example.com" })])],
      },
    ]);
    mounted = await render(
      <LimitsView
        search={parseStatisticsSearch({ view: "limits" })}
        onSearchChange={onSearchChange}
      />,
    );

    const note = page.getByText("also in 127.0.0.1:8317", { exact: false });
    await expect.element(note).toBeVisible();
    expect(document.body.textContent?.toLowerCase()).not.toContain("shared.person@example.com");

    await page.getByRole("radio", { name: "Direct" }).click();
    await expect.element(page.getByText("1 direct", { exact: true })).toBeVisible();
    await expect.element(note).toBeVisible();
  });

  it("takes the banked resets from the node that reported them", async () => {
    const older = new Date(Date.parse(checkedAt) - 60_000).toISOString();
    serve([
      { environmentId: desktop, label: "This machine", status: "ok", hubs: [], providers: [codex] },
      {
        environmentId: ssh,
        label: "Build box",
        status: "ok",
        hubs: [],
        providers: [
          provider({
            ...codex,
            checkedAt: older,
            rateLimits: { ...codex.rateLimits, resetCredits: { availableCount: 2 } },
          }),
        ],
      },
    ]);
    mounted = await render(
      <LimitsView
        search={parseStatisticsSearch({ view: "limits" })}
        onSearchChange={onSearchChange}
      />,
    );

    await expect.element(page.getByText("signed in on 2 nodes", { exact: false })).toBeVisible();
    await expect.element(page.getByText("2 banked resets", { exact: false })).toBeVisible();
  });

  it("judges pace against a live snapshot as soon as it arrives", async () => {
    const pacedCodex = (checkedAtMs: number) =>
      provider({
        ...codex,
        checkedAt: new Date(checkedAtMs).toISOString(),
        rateLimits: {
          planType: "pro",
          // Half of the 5-hour window has passed at the check.
          primary: {
            usedPercent: 23,
            windowDurationMins: 300,
            resetsAt: (checkedAtMs + 150 * 60_000) / 1000,
          },
        },
      });
    const environment = {
      environmentId: desktop,
      label: "This machine",
      status: "ok",
      connected: true,
      hubs: [],
    } as const;
    serve([{ ...environment, providers: [pacedCodex(Date.now() - 1_000)] }]);
    mounted = await render(view());
    const reserve = page.getByRole("button", { name: /27 percentage points below even pace/ });
    await expect.element(reserve).toBeVisible();

    // A provider push read after the view's last tick; no hub read comes with it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const pushedAt = Date.now() - 5;
    harness.result = {
      ...harness.result!,
      environments: [{ ...environment, providers: [pacedCodex(pushedAt)] }],
    };
    await mounted.rerender(view());

    await expect.element(reserve).toBeVisible();
    expect(document.body.textContent).not.toContain("Pace unavailable");
  });

  it("offers the provider settings when nothing reports limits", async () => {
    serve([{ environmentId: desktop, label: "This machine", status: "ok", hubs: [] }]);
    mounted = await render(
      <LimitsView
        search={parseStatisticsSearch({ view: "limits" })}
        onSearchChange={onSearchChange}
      />,
    );

    await expect.element(page.getByText("No subscription limits to show")).toBeVisible();
  });
});
