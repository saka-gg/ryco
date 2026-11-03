import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@ryco/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  clearProviderEditorRequest,
  PROVIDER_EDITOR_REQUEST_TTL_MS,
  requestProviderEditor,
  takeProviderEditorRequest,
  useProviderEditorRequest,
  type ProviderEditorRequest,
} from "./providerEditorRequest";

const STUDIO = EnvironmentId.make("env-studio");
const LAPTOP = EnvironmentId.make("env-laptop");
const NOW = 1_000_000;

const add: ProviderEditorRequest = {
  kind: "add",
  environmentId: STUDIO,
  preset: {
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Work",
    instanceId: ProviderInstanceId.make("claudeAgent_work"),
  },
};

afterEach(() => clearProviderEditorRequest());

describe("the provider editor request", () => {
  it("waits for its device, then opens once", () => {
    requestProviderEditor(add, NOW);
    expect(takeProviderEditorRequest(LAPTOP, { canAdd: true, nowMs: NOW + 1 })).toBeNull();
    expect(takeProviderEditorRequest(null, { canAdd: true, nowMs: NOW + 1 })).toBeNull();
    expect(takeProviderEditorRequest(STUDIO, { canAdd: true, nowMs: NOW + 2 })).toEqual(add);
    expect(takeProviderEditorRequest(STUDIO, { canAdd: true, nowMs: NOW + 3 })).toBeNull();
  });

  it("expires when the device switch never lands, so a later visit opens nothing", () => {
    requestProviderEditor(add, NOW);
    // The switch failed: the editor still shows the laptop.
    expect(takeProviderEditorRequest(LAPTOP, { canAdd: true, nowMs: NOW + 1_000 })).toBeNull();
    // Much later the person opens the studio themselves.
    expect(
      takeProviderEditorRequest(STUDIO, {
        canAdd: true,
        nowMs: NOW + PROVIDER_EDITOR_REQUEST_TTL_MS,
      }),
    ).toBeNull();
    expect(useProviderEditorRequest.getState().request).toBeNull();
  });

  it("never opens the add dialog while the device's settings are blocked", () => {
    requestProviderEditor(add, NOW);
    expect(takeProviderEditorRequest(STUDIO, { canAdd: false, nowMs: NOW + 1 })).toBeNull();
    // Still waiting: the grant may arrive while the switch lands.
    expect(useProviderEditorRequest.getState().request).toEqual(add);
    expect(takeProviderEditorRequest(STUDIO, { canAdd: true, nowMs: NOW + 2 })).toEqual(add);
  });

  it("opens an instance for editing even while the device's settings are read only", () => {
    const edit: ProviderEditorRequest = {
      kind: "edit",
      environmentId: STUDIO,
      instanceId: ProviderInstanceId.make("codex"),
    };
    requestProviderEditor(edit, NOW);
    expect(takeProviderEditorRequest(STUDIO, { canAdd: false, nowMs: NOW + 1 })).toEqual(edit);
  });
});
