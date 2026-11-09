import {
  configFromMcpServerForm,
  formFromMcpServer,
  secretMutationsFromMcpServerForm,
  setMcpFormSecretValue,
} from "@ryco/client-runtime/state/settings/mcpServers";
import { describe, expect, it } from "vite-plus/test";

import { serverFixture } from "./agents.testSupport";
import {
  applyMcpSecretAction,
  mcpSecretEntryProblem,
  mcpSecretRows,
  readLoginPassword,
  SECRET_ACTION,
} from "./mcpServerEditorModel";

const form = formFromMcpServer(
  serverFixture({
    config: {
      ...serverFixture().config,
      // What a node would never send back; the form must not carry it either.
      env: { GITHUB_TOKEN: "leaked" },
    },
  }),
);

describe("MCP server editor secrets", () => {
  it("shows a stored secret as set, never its value", () => {
    const rows = mcpSecretRows(formFromMcpServer(serverFixture()));
    expect(rows).toEqual([
      expect.objectContaining({ id: "env.GITHUB_TOKEN", key: "GITHUB_TOKEN", value: "Set" }),
    ]);
    expect(JSON.stringify(rows)).not.toContain("leaked");
  });

  it("clears, keeps and replaces a stored secret", () => {
    const stored = formFromMcpServer(serverFixture());
    const [row] = mcpSecretRows(stored);
    if (!row) throw new Error("expected a row");
    const cleared = applyMcpSecretAction(stored, row, SECRET_ACTION.clear);
    expect(mcpSecretRows(cleared)[0]?.value).toBe("Clears on save");
    expect(secretMutationsFromMcpServerForm(cleared)).toEqual({
      "env.GITHUB_TOKEN": { action: "clear" },
    });
    const kept = applyMcpSecretAction(cleared, row, SECRET_ACTION.keep);
    expect(secretMutationsFromMcpServerForm(kept)).toEqual({
      "env.GITHUB_TOKEN": { action: "retain" },
    });
    const replaced = setMcpFormSecretValue(cleared, "env", "GITHUB_TOKEN", "fresh");
    expect(mcpSecretRows(replaced)[0]?.value).toBe("New value");
    expect(configFromMcpServerForm(replaced).env).toEqual({ GITHUB_TOKEN: "fresh" });
    const reverted = applyMcpSecretAction(replaced, row, SECRET_ACTION.keep);
    expect(configFromMcpServerForm(reverted).env).toEqual({});
  });

  it("lists a newly typed value after the stored ones and drops it on remove", () => {
    const added = setMcpFormSecretValue(form, "header", "Authorization", "Bearer x");
    const rows = mcpSecretRows(added);
    expect(rows.map((row) => [row.id, row.value])).toEqual([
      ["env.GITHUB_TOKEN", "Set"],
      ["header.Authorization", "New value"],
    ]);
    const dropped = applyMcpSecretAction(added, rows[1]!, SECRET_ACTION.drop);
    expect(mcpSecretRows(dropped).map((row) => row.id)).toEqual(["env.GITHUB_TOKEN"]);
  });

  it("checks what is typed and reads the login-password answer", () => {
    expect(mcpSecretEntryProblem("", "x")).toMatch(/name/);
    expect(mcpSecretEntryProblem("A=B", "x")).toMatch(/=/);
    expect(mcpSecretEntryProblem("A", "")).toMatch(/value/);
    expect(mcpSecretEntryProblem("A", "a\nb")).toMatch(/line break/);
    expect(mcpSecretEntryProblem("A", "b")).toBeNull();
    expect(readLoginPassword({ login: "A", password: "b" })).toEqual({ login: "A", password: "b" });
    expect(readLoginPassword("A")).toBeNull();
  });
});
