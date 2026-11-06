import { describe, expect, it } from "vite-plus/test";
import {
  answerCodexElicitation,
  autoAcceptInRuntimeMode,
  type CodexElicitationParams,
  type CodexElicitationPlan,
  ELICITATION_LABELS,
  planCodexElicitation,
} from "./codexMcpElicitation.ts";

/** What OpenAI's Computer Use plugin sends before it acts in an app (sky computer-use-policy). */
const computerUseApproval: CodexElicitationParams = {
  threadId: "provider-thread",
  turnId: "turn-1",
  serverName: "node_repl",
  mode: "form",
  message: 'Allow Computer Use to use "TextEdit"?',
  requestedSchema: { type: "object", properties: {} },
  _meta: {
    codex_approval_kind: "mcp_tool_call",
    connector_id: "computer-use",
    connector_name: "Computer Use",
    persist: ["session", "always"],
    riskLevel: "low",
    tool_name: "js",
    tool_params: { app: "com.apple.TextEdit" },
    tool_params_display: [{ name: "app", display_name: "App", value: "TextEdit" }],
  },
};

function shown(plan: CodexElicitationPlan) {
  if (plan.kind === "unsupported") throw new Error(plan.reason);
  return plan;
}

describe("planCodexElicitation", () => {
  it("shows OpenAI's Computer Use app approval with its remember options", () => {
    const plan = shown(planCodexElicitation(computerUseApproval));
    expect(plan.kind).toBe("approval");
    expect(plan.questions).toEqual([
      {
        id: "decision",
        header: "Codex Computer Use",
        // The App line repeats the message, so it is left out.
        question: 'Allow Computer Use to use "TextEdit"?',
        options: [
          { label: "Allow once", description: "Ask again next time" },
          { label: "Allow for this chat", description: "Don't ask again in this chat" },
          { label: "Always allow", description: "Don't ask again" },
          { label: "Deny", description: "Don't allow it" },
        ],
        multiSelect: false,
      },
    ]);
  });

  it("offers only the remember options the request lists and adds unseen params", () => {
    const plan = shown(
      planCodexElicitation({
        ...computerUseApproval,
        serverName: "github",
        message: "Allow the github MCP server to run tool create_issue?",
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          persist: "session",
          subtitle: "It writes to your repository.",
          tool_params_display: [
            { name: "repo", display_name: "Repository", value: "acme/app" },
            { name: "title", value: "Crash  on\nstart" },
            { name: "skip" },
          ],
        },
      }),
    );
    const [question] = plan.questions;
    expect(question?.header).toBe("github");
    expect(question?.question).toBe(
      "Allow the github MCP server to run tool create_issue? It writes to your repository. Repository: acme/app title: Crash on start",
    );
    expect(question?.options.map((entry) => entry.label)).toEqual([
      "Allow once",
      "Allow for this chat",
      "Deny",
    ]);
  });

  it("turns form fields into questions, with Skip for optional fields and Decline everywhere", () => {
    const plan = shown(
      planCodexElicitation({
        threadId: "t",
        serverName: "tickets",
        mode: "form",
        message: "Which ticket?",
        requestedSchema: {
          type: "object",
          required: ["id", "priority"],
          properties: {
            id: { type: "string", title: "Ticket id", minLength: 2 },
            count: { type: "integer", minimum: 1, maximum: 5 },
            urgent: { type: "boolean", title: "Urgent" },
            priority: {
              type: "string",
              oneOf: [
                { const: "p1", title: "High" },
                { const: "p2", title: "Low" },
              ],
            },
            tags: { type: "array", items: { type: "string", enum: ["ui", "api"] }, maxItems: 1 },
          },
        },
      }),
    );
    expect(plan.kind).toBe("form");
    expect(plan.questions.map((question) => question.id)).toEqual([
      "field:id",
      "field:count",
      "field:urgent",
      "field:priority",
      "field:tags",
    ]);
    expect(plan.questions[0]).toMatchObject({
      header: "tickets",
      question: "Which ticket? Ticket id:",
      options: [{ label: "Decline" }],
    });
    expect(plan.questions[1]?.question).toBe("count (optional):");
    expect(plan.questions[2]?.options.map((entry) => entry.label)).toEqual([
      "Yes",
      "No",
      "Skip",
      "Decline",
    ]);
    expect(plan.questions[3]?.options.map((entry) => entry.label)).toEqual([
      "High",
      "Low",
      "Decline",
    ]);
    expect(plan.questions[4]).toMatchObject({ multiSelect: true });
  });

  it("asks before a URL request and never opens it", () => {
    const plan = shown(
      planCodexElicitation({
        threadId: "t",
        serverName: "billing",
        mode: "url",
        elicitationId: "e1",
        message: "Sign in to continue.",
        url: "https://example.com/auth",
      }),
    );
    expect(plan.kind).toBe("url");
    expect(plan.questions[0]?.question).toBe("Sign in to continue. Link: https://example.com/auth");
    expect(answerCodexElicitation(plan, { decision: "Continue" })).toEqual({
      ok: true,
      response: { action: "accept" },
    });
    expect(answerCodexElicitation(plan, { decision: "Deny" })).toEqual({
      ok: true,
      response: { action: "decline" },
    });
  });

  it("reads typed openai/form schemas and refuses what it cannot show", () => {
    expect(
      planCodexElicitation({
        threadId: "t",
        serverName: "s",
        mode: "openai/form",
        message: "Name?",
        requestedSchema: { type: "object", properties: { name: { type: "string" } } },
      }).kind,
    ).toBe("form");
    expect(
      planCodexElicitation({
        threadId: "t",
        serverName: "s",
        mode: "openai/form",
        message: "?",
        requestedSchema: { type: "object", properties: { pick: { type: "file" } } },
      }).kind,
    ).toBe("unsupported");
    expect(
      planCodexElicitation({
        threadId: "t",
        serverName: "s",
        mode: "openai/form",
        message: "Approve?",
        requestedSchema: null,
      }).kind,
    ).toBe("approval");
  });
});

describe("answerCodexElicitation", () => {
  const approval = shown(planCodexElicitation(computerUseApproval));

  it("maps each approval choice to the MCP response Codex expects", () => {
    expect(answerCodexElicitation(approval, { decision: "Allow once" })).toEqual({
      ok: true,
      response: { action: "accept" },
    });
    expect(answerCodexElicitation(approval, { decision: "Allow for this chat" })).toEqual({
      ok: true,
      response: { action: "accept", _meta: { persist: "session" } },
    });
    expect(answerCodexElicitation(approval, { decision: ["Always allow"] })).toEqual({
      ok: true,
      response: { action: "accept", _meta: { persist: "always" } },
    });
    for (const decision of ["Deny", "sure, go ahead", undefined]) {
      expect(answerCodexElicitation(approval, { decision })).toEqual({
        ok: true,
        response: { action: "decline" },
      });
    }
  });

  const form = shown(
    planCodexElicitation({
      threadId: "t",
      serverName: "s",
      mode: "form",
      message: "Details",
      requestedSchema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", maxLength: 5 },
          age: { type: "integer", minimum: 0 },
          ok: { type: "boolean" },
          color: { type: "string", enum: ["r", "g"], enumNames: ["Red", "Green"] },
          tags: { type: "array", items: { anyOf: [{ const: "a", title: "A" }] } },
        },
      },
    }),
  );

  it("builds typed content from labels and typed answers", () => {
    expect(
      answerCodexElicitation(form, {
        "field:name": "Ada",
        "field:age": " 36 ",
        "field:ok": "Yes",
        "field:color": "Green",
        "field:tags": ["A"],
      }),
    ).toEqual({
      ok: true,
      response: {
        action: "accept",
        content: { name: "Ada", age: 36, ok: true, color: "g", tags: ["a"] },
      },
    });
    expect(
      answerCodexElicitation(form, {
        "field:name": "Ada",
        "field:age": "Skip",
        "field:ok": "Skip",
        "field:color": "Skip",
        "field:tags": "Skip",
      }),
    ).toEqual({ ok: true, response: { action: "accept", content: { name: "Ada" } } });
  });

  it("declines when any question says Decline and rejects invalid answers", () => {
    expect(answerCodexElicitation(form, { "field:name": "Ada", "field:ok": "Decline" })).toEqual({
      ok: true,
      response: { action: "decline" },
    });
    expect(answerCodexElicitation(form, { "field:name": "toolong" })).toMatchObject({
      ok: false,
      questionId: "field:name",
    });
    expect(answerCodexElicitation(form, { "field:name": "Ada", "field:age": "1.5" })).toMatchObject(
      { ok: false, questionId: "field:age" },
    );
    expect(
      answerCodexElicitation(form, { "field:name": "Ada", "field:color": "Blue" }),
    ).toMatchObject({ ok: false, questionId: "field:color" });
    expect(answerCodexElicitation(form, {})).toMatchObject({ ok: false, questionId: "field:name" });
  });
});

describe("autoAcceptInRuntimeMode", () => {
  const approval = shown(planCodexElicitation(computerUseApproval));

  it("answers tool-call approvals itself only in full access", () => {
    expect(autoAcceptInRuntimeMode(approval, "full-access")).toEqual({ action: "accept" });
    for (const mode of ["approval-required", "auto-accept-edits", "auto"] as const) {
      expect(autoAcceptInRuntimeMode(approval, mode)).toBeUndefined();
    }
  });

  it("always asks for data, links, other approval kinds and explicit user input", () => {
    const asks = [
      planCodexElicitation({
        threadId: "t",
        serverName: "s",
        mode: "form",
        message: "Name?",
        requestedSchema: { type: "object", properties: { name: { type: "string" } } },
      }),
      planCodexElicitation({
        threadId: "t",
        serverName: "s",
        mode: "url",
        elicitationId: "e",
        message: "Open",
        url: "https://example.com",
      }),
      planCodexElicitation({
        ...computerUseApproval,
        _meta: { codex_approval_kind: "tool_suggestion" },
      }),
      planCodexElicitation({ ...computerUseApproval, _meta: undefined }),
      planCodexElicitation({
        ...computerUseApproval,
        _meta: { codex_approval_kind: "mcp_tool_call", codex_requires_user_input: true },
      }),
    ];
    for (const plan of asks) {
      expect(autoAcceptInRuntimeMode(plan, "full-access")).toBeUndefined();
    }
  });

  it("keeps reserved labels unique when an enum reuses them", () => {
    const plan = shown(
      planCodexElicitation({
        threadId: "t",
        serverName: "s",
        mode: "form",
        message: "?",
        requestedSchema: {
          type: "object",
          required: ["x"],
          properties: { x: { type: "string", enum: [ELICITATION_LABELS.decline, "ok"] } },
        },
      }),
    );
    expect(plan.questions[0]?.options.map((entry) => entry.label)).toEqual([
      "Decline (Decline)",
      "ok",
      "Decline",
    ]);
    expect(answerCodexElicitation(plan, { "field:x": "Decline (Decline)" })).toEqual({
      ok: true,
      response: { action: "accept", content: { x: "Decline" } },
    });
  });
});
