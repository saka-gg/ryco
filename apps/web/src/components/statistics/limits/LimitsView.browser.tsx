import "../../../index.css";

import {
  EnvironmentId,
  type CliProxyAccount,
  type CliProxyApiKeyUsage,
  type CliProxyHubSnapshot,
} from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { parseStatisticsSearch, type StatisticsSearch } from "../statisticsSearch";
import { LimitsView } from "./LimitsView";
import type { UseCliProxyHubsResult } from "./useCliProxyHubs";

const harness = vi.hoisted(() => ({
  result: null as UseCliProxyHubsResult | null,
}));

vi.mock("./useCliProxyHubs", () => ({
  useCliProxyHubs: () => harness.result,
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

function serve(
  environments: UseCliProxyHubsResult["environments"],
  availableEnvironments: UseCliProxyHubsResult["availableEnvironments"] = environments,
) {
  harness.result = {
    availableEnvironments,
    environments,
    loading: false,
    refreshing: false,
    receivedAtMs: Date.now(),
    refresh: () => undefined,
  };
}

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
});
