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
      rateLimits: { primary: { usedPercent: 40, windowDurationMins: 300 } },
    });
    serve([
      {
        environmentId: desktop,
        label: "This machine",
        status: "ok",
        providers: [routedClaude, directClaude],
        hubs: [
          {
            ...loopbackHub([
              account({
                quota: {
                  status: "ok",
                  checkedAt,
                  windows: [{ id: "five_hour", usedPercent: 20, windowDurationMins: 300 }],
                },
              }),
            ]),
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

    await expect.element(page.getByText("1 direct · 1 via hub")).toBeVisible();
    // The pool averages the direct 40% and the hub's 20%.
    await expect.element(page.getByText("70% left")).toBeVisible();
    await expect.element(page.getByText("Claude proxied", { exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain("99% used");

    await page.getByRole("radio", { name: "CLIProxyAPI" }).click();
    await expect.element(page.getByText("1 via hub", { exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain("Claude Max Subscription");
    expect(document.body.textContent).not.toContain("Claude proxied");

    await page.getByRole("radio", { name: "Direct" }).click();
    await expect.element(page.getByText("1 direct", { exact: true })).toBeVisible();
    expect(page.getByRole("heading", { name: "Hubs" }).query()).toBeNull();
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
