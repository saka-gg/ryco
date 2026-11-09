import { describe, expect, it } from "vite-plus/test";

import {
  configFromMcpServerForm,
  createEmptyMcpServerForm,
  formFromMcpServer,
  isMcpServerWritable,
  mcpFormPendingSecretKeys,
  mcpServerStatus,
  parseMcpSecretField,
  secretMutationsFromMcpServerForm,
  setMcpFormSecretCleared,
  setMcpFormSecretValue,
} from "./mcpServers.ts";

const server = {
  name: "tools",
  config: {
    transport: "stdio",
    command: "node",
    args: ["server.js"],
    cwd: null,
    env: {},
    envVars: [],
    httpHeaders: {},
    envHttpHeaders: {},
    enabled: true,
    enabledTools: [],
    disabledTools: [],
    oauthScopes: [],
    secretFields: { "env.API_TOKEN": "present", "header.Authorization": "present" },
  },
  source: "user",
  startupStatus: "unknown",
  authStatus: "unknown",
  tools: [],
  resources: [],
  resourceTemplates: [],
} as const;

describe("MCP server form secrets", () => {
  it("hydrates presence only and expresses retain or clear explicitly", () => {
    const form = formFromMcpServer(server as never);
    expect(form.envText).toBe("");
    expect(form.httpHeadersText).toBe("");
    expect(form.secretFields).toEqual(["env.API_TOKEN", "header.Authorization"]);
    expect(secretMutationsFromMcpServerForm(form)).toEqual({
      "env.API_TOKEN": { action: "retain" },
      "header.Authorization": { action: "retain" },
    });
    expect(
      secretMutationsFromMcpServerForm({
        ...form,
        clearedSecretFields: ["env.API_TOKEN"],
      }),
    ).toEqual({
      "env.API_TOKEN": { action: "clear" },
      "header.Authorization": { action: "retain" },
    });
  });
});

describe("MCP server form never loads a secret value", () => {
  it("treats a value an unredacted node sent as stored, not as text", () => {
    const form = formFromMcpServer({
      ...server,
      config: {
        ...server.config,
        env: { LEAKED: "value" },
        httpHeaders: { "X-Key": "value" },
        secretFields: {},
      },
    } as never);
    expect(form.envText).toBe("");
    expect(form.httpHeadersText).toBe("");
    expect(form.secretFields).toEqual(["env.LEAKED", "header.X-Key"]);
    expect(JSON.stringify(form)).not.toContain("value");
  });
});

describe("MCP server form write-only secret entry", () => {
  it("adds, replaces and drops typed values without touching stored ones", () => {
    const form = formFromMcpServer(server as never);
    const added = setMcpFormSecretValue(form, "env", "NEW_TOKEN", "s3cret=with=equals");
    expect(mcpFormPendingSecretKeys(added, "env")).toEqual(["NEW_TOKEN"]);
    expect(configFromMcpServerForm(added).env).toEqual({ NEW_TOKEN: "s3cret=with=equals" });
    // Stored fields are still retained; their values never came back.
    expect(secretMutationsFromMcpServerForm(added)).toEqual({
      "env.API_TOKEN": { action: "retain" },
      "header.Authorization": { action: "retain" },
    });

    const dropped = setMcpFormSecretValue(added, "env", "NEW_TOKEN", null);
    expect(mcpFormPendingSecretKeys(dropped, "env")).toEqual([]);
    expect(configFromMcpServerForm(dropped).env).toEqual({});
  });

  it("replacing a stored key takes it off the fields to clear", () => {
    const cleared = setMcpFormSecretCleared(
      formFromMcpServer(server as never),
      "env.API_TOKEN",
      true,
    );
    expect(secretMutationsFromMcpServerForm(cleared)["env.API_TOKEN"]).toEqual({ action: "clear" });
    const replaced = setMcpFormSecretValue(cleared, "env", "API_TOKEN", "fresh");
    expect(replaced.clearedSecretFields).toEqual([]);
    expect(configFromMcpServerForm(replaced).env).toEqual({ API_TOKEN: "fresh" });
    expect(setMcpFormSecretCleared(cleared, "env.API_TOKEN", false).clearedSecretFields).toEqual(
      [],
    );
  });

  it("refuses keys and values that would break the one-line-per-entry text", () => {
    const form = createEmptyMcpServerForm();
    expect(setMcpFormSecretValue(form, "header", "", "x")).toBe(form);
    expect(setMcpFormSecretValue(form, "header", "A=B", "x")).toBe(form);
    expect(setMcpFormSecretValue(form, "header", "Authorization", "a\nb")).toBe(form);
    const header = setMcpFormSecretValue(form, "header", " Authorization ", "Bearer x");
    expect(configFromMcpServerForm(header).httpHeaders).toEqual({ Authorization: "Bearer x" });
  });

  it("parses stored secret field names", () => {
    expect(parseMcpSecretField("env.API_TOKEN")).toEqual({ kind: "env", key: "API_TOKEN" });
    expect(parseMcpSecretField("header.X.Y")).toEqual({ kind: "header", key: "X.Y" });
    expect(parseMcpSecretField("other.KEY")).toBeNull();
    expect(parseMcpSecretField("env.")).toBeNull();
  });
});

describe("MCP server presentation", () => {
  it("reads a disabled, failed or signed-out server before a ready one", () => {
    expect(mcpServerStatus({ ...server, startupStatus: "disabled" } as never).label).toBe(
      "Disabled",
    );
    expect(mcpServerStatus({ ...server, startupStatus: "failed" } as never).tone).toBe("error");
    expect(
      mcpServerStatus({ ...server, startupStatus: "ready", authStatus: "notLoggedIn" } as never)
        .label,
    ).toBe("Login needed");
    expect(mcpServerStatus({ ...server, startupStatus: "ready" } as never).tone).toBe("success");
  });

  it("lets Ryco change user servers, and project ones only in the project scope", () => {
    const project = { ...server, source: "project" } as never;
    expect(isMcpServerWritable(server as never, null)).toBe(true);
    expect(isMcpServerWritable(project, null)).toBe(false);
    expect(isMcpServerWritable(project, { nativeScope: "project" } as never)).toBe(true);
    expect(isMcpServerWritable({ ...server, source: "managed" } as never, null)).toBe(false);
  });
});
