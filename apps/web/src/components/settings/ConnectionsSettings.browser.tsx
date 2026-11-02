import "../../index.css";

import { EnvironmentId } from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY } from "../../clientPersistenceStorage";
import {
  resetEnvironmentServiceForTests,
  resetSavedEnvironmentRegistryStoreForTests,
  resetSavedEnvironmentRuntimeStoreForTests,
  useSavedEnvironmentRegistryStore,
  type SavedEnvironmentRecord,
} from "../../environments/runtime";
import { __resetLocalApiForTests } from "../../localApi";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { ConnectionsSettings } from "./ConnectionsSettings";

// The real environment runtime, catalog and browser storage: nothing here is
// mocked. Without a running connection service, switching a machine changes
// its record and session only; the supervisor's own tests cover connecting.
const environmentId = EnvironmentId.make("env-studio");
const record: SavedEnvironmentRecord = {
  environmentId,
  label: "Studio Mac",
  httpBaseUrl: "http://127.0.0.1:9/",
  wsBaseUrl: "ws://127.0.0.1:9/",
  createdAt: "2026-10-24T00:00:00.000Z",
  lastConnectedAt: null,
};

function storedRecords(): ReadonlyArray<{ environmentId: string; disabledAt?: string }> {
  const raw = localStorage.getItem(SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY);
  return raw ? (JSON.parse(raw) as { records: [] }).records : [];
}

describe("ConnectionsSettings saved machine switch", () => {
  let mounted: Awaited<ReturnType<typeof render>> | null = null;

  beforeEach(async () => {
    localStorage.clear();
    await __resetLocalApiForTests();
    resetSavedEnvironmentRegistryStoreForTests();
    resetSavedEnvironmentRuntimeStoreForTests();
  });

  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    await resetEnvironmentServiceForTests();
    resetSavedEnvironmentRegistryStoreForTests();
    resetSavedEnvironmentRuntimeStoreForTests();
    localStorage.clear();
    document.body.innerHTML = "";
  });

  async function renderSettings() {
    mounted = await render(
      <AppAtomRegistryProvider>
        <ConnectionsSettings />
      </AppAtomRegistryProvider>,
    );
    await expect.element(page.getByRole("heading", { name: "Studio Mac" })).toBeInTheDocument();
  }

  it("lists a switched-off machine dimmed, with no Connect, and keeps Remove", async () => {
    useSavedEnvironmentRegistryStore
      .getState()
      .upsert({ ...record, disabledAt: "2026-10-31T09:00:00.000Z" });
    await renderSettings();

    const toggle = page.getByRole("switch", { name: "Use Studio Mac" });
    await expect.element(toggle).not.toBeChecked();
    await expect.element(page.getByText("Switched off", { exact: true })).toBeInTheDocument();
    expect(document.querySelector("[data-switched-off] .opacity-60")).not.toBeNull();
    await expect.element(page.getByRole("button", { name: "Connect" })).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Re-pair" })).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });

  it("switches a machine off and on, keeping its record saved throughout", async () => {
    useSavedEnvironmentRegistryStore.getState().upsert(record);
    await renderSettings();

    const toggle = page.getByRole("switch", { name: "Use Studio Mac" });
    await expect.element(toggle).toBeChecked();
    await expect.element(page.getByRole("button", { name: "Connect" })).toBeInTheDocument();
    expect(document.querySelector("[data-switched-off]")).toBeNull();

    await toggle.click();
    await expect.element(toggle).not.toBeChecked();
    await expect.element(page.getByText("Switched off", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Connect" })).not.toBeInTheDocument();
    expect(useSavedEnvironmentRegistryStore.getState().byId[environmentId]?.disabledAt).toBeTypeOf(
      "string",
    );
    await expect
      .poll(() => storedRecords())
      .toEqual([expect.objectContaining({ environmentId, disabledAt: expect.any(String) })]);

    await toggle.click();
    await expect.element(toggle).toBeChecked();
    await expect.element(page.getByRole("button", { name: "Connect" })).toBeInTheDocument();
    expect(useSavedEnvironmentRegistryStore.getState().byId[environmentId]).toEqual(record);
    await expect.poll(() => storedRecords()).toEqual([expect.objectContaining({ environmentId })]);
    expect(storedRecords()[0]?.disabledAt).toBeUndefined();
  });
});
