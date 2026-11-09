import type { WsRpcClient } from "@ryco/client-runtime/rpc";
import {
  buildConversationImportView,
  INITIAL_CONVERSATION_IMPORT_STATE,
  SESSION_IMPORT_RECONNECT,
} from "@ryco/client-runtime/state/sessionImport";
import { EnvironmentId } from "@ryco/contracts/base-schemas";
import { describe, expect, it } from "vite-plus/test";

import {
  createMachineImportClient,
  machineImportButtonLabel,
  machineImportCanRun,
  machineImportProjects,
} from "./machineImportModel";

const here = EnvironmentId.make("here");
const there = EnvironmentId.make("there");

describe("machine import", () => {
  it("reads the machine's live client for every call and refuses without one", () => {
    const sessionImport = {} as WsRpcClient["sessionImport"];
    let client: WsRpcClient | null = { sessionImport } as WsRpcClient;
    const read = createMachineImportClient(() => client);
    expect(read()).toBe(sessionImport);
    client = null;
    expect(read).toThrow(SESSION_IMPORT_RECONNECT);
  });

  it("offers this machine's projects by name, without chats", () => {
    expect(
      machineImportProjects(
        [
          { id: "b", name: "Beta", environmentId: here },
          { id: "chat", name: "Chats", environmentId: here, kind: "chat" },
          { id: "a", name: "Alpha", environmentId: here, kind: "project" },
          { id: "x", name: "Elsewhere", environmentId: there },
        ],
        here,
      ),
    ).toEqual([
      { id: "a", name: "Alpha" },
      { id: "b", name: "Beta" },
    ]);
  });

  it("words the button by what a run would import", () => {
    const view = buildConversationImportView(INITIAL_CONVERSATION_IMPORT_STATE, {
      allowed: true,
      projects: [],
      providerOptions: [],
    });
    expect(machineImportButtonLabel(view)).toBe("Select conversations");
    expect(machineImportButtonLabel({ ...view, importableCount: 2 })).toBe(
      "Import 2 conversations",
    );
    expect(machineImportButtonLabel({ ...view, busy: true })).toBe("Working…");
    expect(machineImportCanRun({ ...view, canRun: true, importableCount: 0 })).toBe(false);
    expect(machineImportCanRun({ ...view, canRun: true, importableCount: 1 })).toBe(true);
  });
});
