import type {
  AgentInfo,
  AgentListOutput,
  ConfigEntry,
  FormInfo,
  ModelInfo,
  ModelListOutput,
  PermissionRuleset as V2PermissionRuleset,
  ProviderInfo,
  SessionInfo,
} from "@opencode/client";
import type { RuntimeMode } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { readOpenCode2Transcript } from "./__fixtures__/opencode2/transcripts.ts";
import { buildOpenCodePermissionRules } from "./opencodeRuntime.ts";
import {
  isUnsupportedOpenCodeV2Form,
  openCodeV1Rules,
  openCodeV2Agent,
  openCodeV2DefaultAgent,
  openCodeV2FormAnswers,
  openCodeV2FormResponse,
  openCodeV2McpConfig,
  openCodeV2ModelRef,
  openCodeV2Permission,
  openCodeV2Prompt,
  openCodeV2ProviderList,
  openCodeV2Question,
  openCodeV2Rules,
  openCodeV2Session,
} from "./openCodeV2Mapping.ts";

const permissionTranscript = readOpenCode2Transcript("permission");
const [agentList] = permissionTranscript.responses("agent.list") as ReadonlyArray<AgentListOutput>;
const buildAgent = agentList!.data.find((agent) => agent.id === "build")!;

/** OpenCode's rule evaluation: `*` and `?` wildcards on action and resource, last match wins. */
function evaluate(rules: V2PermissionRuleset, action: string, resource: string) {
  const matches = (pattern: string, value: string) =>
    new RegExp(
      `^${pattern
        .split("")
        .map((char) =>
          char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.+^${}()|[\]\\]/g, "\\$&"),
        )
        .join("")}$`,
      "s",
    ).test(value);
  return rules.findLast((rule) => matches(rule.action, action) && matches(rule.resource, resource))
    ?.effect;
}

const RESOURCES = [
  "*",
  "rm -rf /",
  "echo hi",
  "/etc/passwd",
  ".env",
  "<home>/config/opencode/opencode.json",
  "<home>/data/opencode/tool-output/out",
  "/tmp/opencode/scratch",
];

describe("OpenCode 2 permission rules", () => {
  it("renames 1.x permissions and keeps the rule order", () => {
    expect(
      openCodeV2Rules([
        { permission: "*", pattern: "*", action: "ask" },
        { permission: "bash", pattern: "git *", action: "allow" },
        { permission: "task", pattern: "*", action: "deny" },
        { permission: "write", pattern: "*.md", action: "allow" },
        { permission: "patch", pattern: "*", action: "ask" },
        { permission: "external_directory", pattern: "*", action: "ask" },
      ]),
    ).toEqual([
      { action: "*", resource: "*", effect: "ask" },
      { action: "shell", resource: "git *", effect: "allow" },
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "edit", resource: "*.md", effect: "allow" },
      { action: "edit", resource: "*", effect: "ask" },
      { action: "external_directory", resource: "*", effect: "ask" },
    ]);
    expect(
      openCodeV1Rules([
        { action: "shell", resource: "*", effect: "ask" },
        { action: "subagent", resource: "*", effect: "allow" },
        { action: "constructor", resource: "*", effect: "deny" },
      ]),
    ).toEqual([
      { permission: "bash", pattern: "*", action: "ask" },
      { permission: "task", pattern: "*", action: "allow" },
      { permission: "constructor", pattern: "*", action: "deny" },
    ]);
  });

  it.each(["approval-required", "auto-accept-edits", "auto"] satisfies ReadonlyArray<RuntimeMode>)(
    "never lets a shell, edit or outside-directory request through on its own in %s mode",
    (mode) => {
      // Session rules apply after the agent's own, which on their own allow shell commands.
      expect(evaluate(buildAgent.permissions, "shell", "rm -rf /")).toBe("allow");
      const rules = [
        ...buildAgent.permissions,
        ...openCodeV2Rules(buildOpenCodePermissionRules(mode)),
      ];
      for (const action of ["shell", "edit", "external_directory"]) {
        for (const resource of RESOURCES) {
          expect(evaluate(rules, action, resource), `${action} ${resource}`).not.toBe("allow");
        }
      }
      expect(evaluate(rules, "question", "*")).toBe("allow");
    },
  );

  it("allows everything in full-access mode", () => {
    const rules = [
      ...buildAgent.permissions,
      ...openCodeV2Rules(buildOpenCodePermissionRules("full-access")),
    ];
    for (const resource of RESOURCES) expect(evaluate(rules, "shell", resource)).toBe("allow");
  });

  it("keeps a deny-all session denying everything", () => {
    const rules = [
      ...buildAgent.permissions,
      ...openCodeV2Rules([{ permission: "*", pattern: "*", action: "deny" }]),
    ];
    for (const action of ["shell", "edit", "read", "external_directory", "question", "subagent"]) {
      for (const resource of RESOURCES) expect(evaluate(rules, action, resource)).toBe("deny");
    }
  });
});

describe("OpenCode 2 sessions, agents and models", () => {
  it("maps a session to the 1.x shape", () => {
    const [created] = readOpenCode2Transcript("simple").responses(
      "session.create",
    ) as ReadonlyArray<{
      readonly data: SessionInfo;
    }>;
    expect(
      openCodeV2Session({
        ...created!.data,
        parentID: "ses_parent",
        permissions: [{ action: "shell", resource: "*", effect: "ask" }],
      }),
    ).toEqual({
      id: "ses_f148cdfa1ffeIFwbC0FCx0fKpk",
      slug: "ses_f148cdfa1ffeIFwbC0FCx0fKpk",
      version: "2",
      projectID: "global",
      directory: "<work>",
      title: "spike simple",
      parentID: "ses_parent",
      time: { created: 1790656585840, updated: 1790656585840 },
      model: { id: "space-bunny-free", providerID: "opencode", variant: "high" },
      permission: [{ permission: "bash", pattern: "*", action: "ask" }],
    });
  });

  it("maps an agent without its prompt or request settings", () => {
    const agent = openCodeV2Agent({
      ...buildAgent,
      system: "secret system prompt",
      model: { id: "big-pickle", providerID: "opencode", variant: "max" },
    });
    expect(agent).toMatchObject({
      name: "build",
      mode: "primary",
      hidden: false,
      options: {},
      model: { providerID: "opencode", modelID: "big-pickle" },
      variant: "max",
    });
    expect(agent.permission[0]).toEqual({ permission: "*", pattern: "*", action: "allow" });
    expect(JSON.stringify(agent)).not.toContain("secret system prompt");
    expect(Object.keys(agent)).not.toContain("request");
  });

  it("finds the default agent the way 1.x does", () => {
    const agent = (id: string, overrides: Partial<AgentInfo> = {}): AgentInfo => ({
      ...buildAgent,
      id,
      name: id,
      ...overrides,
    });
    const agents = [
      agent("build"),
      agent("plan"),
      agent("coder"),
      agent("explore", { mode: "subagent" }),
      agent("title", { hidden: true }),
    ];
    const configured = (...names: ReadonlyArray<string | undefined>): Array<ConfigEntry> =>
      names.map((name, index) => ({
        type: "document",
        path: `/config/${index}/opencode.json`,
        info: name === undefined ? {} : { default_agent: name },
      }));

    // Documents come lowest priority first; the last one that names an agent wins.
    expect(
      openCodeV2DefaultAgent(
        [...configured("plan", "coder", undefined), { type: "directory", path: "/work" }],
        agents,
      ),
    ).toBe("coder");
    expect(openCodeV2DefaultAgent([], agents)).toBe("build");
    // Only a visible primary agent can be the default.
    for (const name of ["explore", "title", "missing"]) {
      expect(openCodeV2DefaultAgent(configured(name), agents)).toBe("build");
    }
    // Without `build` (disabled), the first visible primary agent.
    expect(openCodeV2DefaultAgent([], agents.slice(1))).toBe("plan");
    expect(openCodeV2DefaultAgent([], [])).toBe("build");
  });

  it("lists enabled models of connected providers without settings, headers or keys", () => {
    const [listed] = permissionTranscript.responses("model.list") as ReadonlyArray<ModelListOutput>;
    const disabled: ModelInfo = {
      ...listed!.data[0]!,
      id: "claude-x",
      modelID: "claude-x",
      providerID: "anthropic",
      name: "Claude X",
      enabled: false,
      headers: { "x-api-key": "sk-ant-model-secret" },
    };
    const providers: ReadonlyArray<ProviderInfo> = [
      {
        id: "opencode",
        name: "OpenCode Zen",
        activation: "auto",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { apiKey: "sk-provider-secret", baseURL: "https://opencode.ai/zen/v1" },
        headers: { Authorization: "Bearer provider-secret" },
      },
      { id: "anthropic", name: "Anthropic", activation: "auto", package: "@ai-sdk/anthropic" },
    ];
    const list = openCodeV2ProviderList(providers, [...listed!.data, disabled]);

    expect(list.connected).toEqual(["opencode"]);
    expect(list.all.map((provider) => [provider.id, Object.keys(provider.models)])).toEqual([
      ["opencode", ["space-bunny-free", "big-pickle"]],
      ["anthropic", []],
    ]);
    const model = list.all[0]!.models["space-bunny-free"]!;
    expect(model).toMatchObject({
      id: "space-bunny-free",
      providerID: "opencode",
      name: "Space Bunny Free",
      limit: { context: 1048576, input: 524288, output: 524288 },
      capabilities: { reasoning: true, toolcall: true, attachment: true },
      options: {},
      headers: {},
      api: { id: "space-bunny-free", url: "", npm: "" },
    });
    expect(Object.keys(model.variants ?? {})).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(list.all[0]!.models["big-pickle"]?.capabilities.reasoning).toBe(false);
    const serialized = JSON.stringify(list);
    for (const leaked of ["apiKey", "secret", "public", "baseURL", "settings", "reasoningEffort"]) {
      expect(serialized).not.toContain(leaked);
    }
  });

  it("maps a listed permission request to the 1.x request", () => {
    expect(
      openCodeV2Permission({
        id: "per_1",
        sessionID: "ses",
        action: "subagent",
        resources: ["explore"],
        metadata: { agent: "explore" },
      }),
    ).toEqual({
      id: "per_1",
      sessionID: "ses",
      permission: "task",
      patterns: ["explore"],
      always: [],
      metadata: { agent: "explore" },
    });
  });
});

const FORM: FormInfo = {
  id: "frm_1",
  sessionID: "ses",
  title: "Setup",
  metadata: { tool: { messageID: "msg", id: "call" } },
  fields: [
    {
      key: "color",
      type: "string",
      title: "Color",
      description: "Pick a color",
      required: true,
      options: [
        { value: "red", label: "Red", description: "Warm" },
        { value: "blue", label: "Blue" },
      ],
    },
    { key: "name", type: "string", title: "Name" },
    { key: "count", type: "integer", description: "How many?", required: true },
    { key: "ratio", type: "number" },
    { key: "confirm", type: "boolean", title: "Confirm" },
    {
      key: "tags",
      type: "multiselect",
      title: "Tags",
      options: [
        { value: "a", label: "Alpha" },
        { value: "b", label: "Beta" },
      ],
    },
  ],
};

describe("OpenCode 2 forms", () => {
  it("maps each field to a 1.x question, in order", () => {
    expect(openCodeV2Question(FORM)).toEqual({
      id: "frm_1",
      sessionID: "ses",
      tool: { messageID: "msg", callID: "call" },
      questions: [
        {
          header: "Color",
          question: "Pick a color",
          options: [
            { label: "Red", description: "Warm" },
            { label: "Blue", description: "Blue" },
          ],
          custom: false,
        },
        { header: "Name", question: "Name", options: [], custom: true },
        { header: "Setup", question: "How many?", options: [], custom: true },
        { header: "Setup", question: "ratio", options: [], custom: true },
        {
          header: "Confirm",
          question: "Confirm",
          options: [
            { label: "Yes", description: "Yes" },
            { label: "No", description: "No" },
          ],
          custom: false,
        },
        {
          header: "Tags",
          question: "Tags",
          options: [
            { label: "Alpha", description: "Alpha" },
            { label: "Beta", description: "Beta" },
          ],
          multiple: true,
          custom: false,
        },
      ],
    });
  });

  it("turns positional answers into the form's answer, picking option values by label", () => {
    expect(
      openCodeV2FormResponse(FORM, [["Red"], ["Ada"], ["3"], ["0.5"], ["Yes"], ["Alpha", "b"]]),
    ).toEqual({
      type: "reply",
      answer: { color: "red", name: "Ada", count: 3, ratio: 0.5, confirm: true, tags: ["a", "b"] },
    });
    // Typed answers and optional fields left empty.
    expect(openCodeV2FormResponse(FORM, [["green"], [], ["2"], [" "], ["false"], []])).toEqual({
      type: "reply",
      answer: { color: "green", count: 2, confirm: false },
    });
  });

  it("cancels a form answered with nothing, and rejects invalid or missing required answers", () => {
    expect(openCodeV2FormResponse(FORM, [])).toEqual({ type: "cancel" });
    expect(openCodeV2FormResponse(FORM, [[], [""], []])).toEqual({ type: "cancel" });
    expect(() => openCodeV2FormResponse(FORM, [["Red"]])).toThrow(
      "OpenCode needs an answer for count.",
    );
    expect(() => openCodeV2FormResponse(FORM, [["Red"], [], ["2.5"]])).toThrow(
      "OpenCode expects a whole number for count.",
    );
    expect(() => openCodeV2FormResponse(FORM, [["Red"], [], ["2"], [], ["maybe"]])).toThrow(
      "OpenCode expects yes or no for Confirm.",
    );
  });

  it.each([
    { key: "link", type: "external", url: "https://example.com/oauth", title: "Sign in" },
    { key: "secret", type: "string", hidden: true },
    { key: "detail", type: "string", when: [{ key: "confirm", op: "eq", value: true }] },
  ] satisfies FormInfo["fields"])(
    "offers a form with a $key field only as cancellable",
    (field) => {
      const form: FormInfo = { ...FORM, fields: [FORM.fields[0], field] };
      expect(isUnsupportedOpenCodeV2Form(form)).toBe(true);
      expect(openCodeV2Question(form).questions).toEqual([
        {
          header: "Setup",
          question: "This form needs OpenCode's interface. Complete it there, or cancel it here.",
          options: [{ label: "Cancel", description: "Cancel this OpenCode form" }],
          custom: false,
        },
      ]);
      expect(openCodeV2FormResponse(form, [["Cancel"]])).toEqual({ type: "cancel" });
      expect(openCodeV2FormResponse(form, [["Red"], ["anything"]])).toEqual({ type: "cancel" });
      expect(openCodeV2FormAnswers(form, { color: "red" })).toEqual([]);
    },
  );

  it("shows a settled form's answer with option labels", () => {
    expect(
      openCodeV2FormAnswers(FORM, { color: "red", count: 3, confirm: false, tags: ["b", "z"] }),
    ).toEqual([["Red"], [], ["3"], [], ["No"], ["Beta", "z"]]);
  });
});

describe("OpenCode 2 requests", () => {
  it("joins a prompt's text and references its files by URL", () => {
    expect(
      openCodeV2Prompt([
        { type: "text", text: "Look at this" },
        { type: "file", mime: "image/png", url: "data:image/png;base64,AA==", filename: "a.png" },
        { type: "file", mime: "text/plain", url: "file:///tmp/notes.txt" },
        { type: "text", text: "and that" },
        { type: "agent", name: "explore" },
      ]),
    ).toEqual({
      text: "Look at this\n\nand that",
      files: [
        { uri: "data:image/png;base64,AA==", name: "a.png" },
        { uri: "file:///tmp/notes.txt" },
      ],
      agents: [{ name: "explore" }],
    });
    expect(openCodeV2Prompt(undefined)).toEqual({ text: "" });
  });

  it("names a model and variant as a 2.x model reference", () => {
    const model = { providerID: "opencode", modelID: "big-pickle" };
    expect(openCodeV2ModelRef(model, "high")).toEqual({
      providerID: "opencode",
      id: "big-pickle",
      variant: "high",
    });
    expect(openCodeV2ModelRef(model, undefined)).toEqual({
      providerID: "opencode",
      id: "big-pickle",
    });
  });

  it("maps local and remote MCP configs", () => {
    expect(
      openCodeV2McpConfig({
        type: "local",
        command: ["node", "server.js"],
        cwd: "/srv",
        environment: { TOKEN: "t" },
        enabled: false,
        timeout: 5_000,
      }),
    ).toEqual({
      type: "local",
      command: ["node", "server.js"],
      cwd: "/srv",
      environment: { TOKEN: "t" },
      disabled: true,
      timeout: { catalog: 5_000, execution: 5_000 },
    });
    expect(
      openCodeV2McpConfig({
        type: "remote",
        url: "https://mcp.example/mcp",
        headers: { Authorization: "Bearer t" },
        oauth: {
          clientId: "id",
          clientSecret: "secret",
          scope: "read",
          callbackPort: 19876,
          redirectUri: "http://127.0.0.1:19876/callback",
        },
      }),
    ).toEqual({
      type: "remote",
      url: "https://mcp.example/mcp",
      headers: { Authorization: "Bearer t" },
      oauth: {
        client_id: "id",
        client_secret: "secret",
        scope: "read",
        callback_port: 19876,
        redirect_uri: "http://127.0.0.1:19876/callback",
      },
      disabled: false,
    });
    expect(
      openCodeV2McpConfig({ type: "remote", url: "http://127.0.0.1:9/mcp", oauth: false }),
    ).toEqual({ type: "remote", url: "http://127.0.0.1:9/mcp", oauth: false, disabled: false });
  });
});
