import type { AgentControlProposalView } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  AUTOMATION_COMMAND_UNCONFIRMED,
  createAutomationRequestIds,
  sendAutomationCommand,
  type AutomationCommandDraft,
} from "./commands.ts";

const draft = {
  kind: "retry",
  projectId: "project-1",
  runId: "run-1",
} as unknown as AutomationCommandDraft;

function counter() {
  let n = 0;
  return () => `request-${++n}`;
}

describe("automation command request ids", () => {
  it("gives every answered action a new id", async () => {
    const ids = createAutomationRequestIds(counter());
    const seen: string[] = [];
    const command = async (input: { requestId: string }) => void seen.push(input.requestId);
    expect(await sendAutomationCommand({ ids, command, draft })).toEqual({ ok: true });
    expect(await sendAutomationCommand({ ids, command, draft })).toEqual({ ok: true });
    expect(seen).toEqual(["request-1", "request-2"]);
  });

  it("keeps the id of an attempt whose answer was lost, until its proposal shows up", async () => {
    const ids = createAutomationRequestIds(counter());
    const lost = async () => {
      throw new Error("socket closed");
    };
    expect(await sendAutomationCommand({ ids, command: lost, draft })).toEqual({
      ok: false,
      error: "socket closed",
    });
    expect(ids.idFor(draft)).toBe("request-1");
    ids.absorbQueue([{ requestId: "request-1" } as unknown as AgentControlProposalView]);
    expect(ids.idFor(draft)).toBe("request-2");
  });

  it("forgets the id once the server refused the action", async () => {
    const ids = createAutomationRequestIds(counter());
    const refused = async () => {
      throw Object.assign(new Error(""), { _tag: "AgentControlRpcError" });
    };
    expect(await sendAutomationCommand({ ids, command: refused, draft })).toEqual({
      ok: false,
      error: AUTOMATION_COMMAND_UNCONFIRMED,
    });
    expect(ids.idFor(draft)).toBe("request-2");
  });
});
