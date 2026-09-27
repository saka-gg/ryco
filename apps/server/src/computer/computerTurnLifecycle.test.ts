import { afterEach, expect, it } from "vitest";
import {
  computerTurnPlan,
  stageComputerTurn,
  bindComputerTurn,
  computerTurnPlanForAuthority,
  retireComputerTurn,
  onComputerTurnRetired,
} from "./computerTurnLifecycle.ts";
const thread = "computer-lifecycle-test";
afterEach(() => stageComputerTurn(thread, undefined));
const stage = (text: string, generation = "epoch:0") =>
  stageComputerTurn(thread, {
    text,
    intent: { mode: "request", generation },
    runtimeMode: "full-access",
    label: "Task",
  });
it("keeps an explicit visible-use request through a routine human continuation only", () => {
  stage("/computer-use Show me the browser window");
  expect(computerTurnPlan(thread)?.visibleIntentText).toBe("Show me the browser window");
  stage("/computer-use continue working");
  expect(computerTurnPlan(thread)?.visibleIntentText).toBe("Show me the browser window");
  stage("/computer-use Find a receipt in the background");
  expect(computerTurnPlan(thread)?.visibleIntentText).toBeUndefined();
  stage("/computer-use continue");
  expect(computerTurnPlan(thread)?.visibleIntentText).toBeUndefined();
});
it("does not carry visible consent across Stop, an ordinary coding task, or a restart", () => {
  stage("Show me the browser window");
  stage("continue", "new-epoch:0");
  expect(computerTurnPlan(thread)?.visibleIntentText).toBeUndefined();
  stage("Show me the browser window");
  stageComputerTurn(thread, undefined);
  stage("continue");
  expect(computerTurnPlan(thread)?.visibleIntentText).toBeUndefined();
});
it("retirement preserves exact task identity and unsubscribes", () => {
  const seen: string[][] = [];
  const remove = onComputerTurnRetired((threadId, turnId) => seen.push([threadId, turnId]));
  retireComputerTurn(thread, "old-turn");
  remove();
  retireComputerTurn(thread, "new-turn");
  expect(seen).toEqual([[thread, "old-turn"]]);
});

it("accepts a direct human answer to the current task's visibility question", () => {
  stage("Inspect Calculator");
  stageComputerTurn(thread, {
    text: "/computer-use yes",
    previousAssistantText: "Can I bring the Calculator window to the front?",
    intent: { mode: "request", generation: "epoch:0" },
    runtimeMode: "full-access",
    label: "Calculator",
  });
  expect(computerTurnPlan(thread)?.foregroundAuthorized).toBe(true);
  stage("continue");
  expect(computerTurnPlan(thread)?.foregroundAuthorized).toBe(true);
});

it("never transfers one human invocation to an automatic subsequent turn", () => {
  stage("Inspect Calculator");
  bindComputerTurn(thread, "human-turn");
  expect(computerTurnPlanForAuthority(thread, "human-turn")).toBeDefined();
  retireComputerTurn(thread, "human-turn");
  bindComputerTurn(thread, "automatic-turn");
  expect(computerTurnPlanForAuthority(thread, "automatic-turn")).toBeUndefined();
  stage("Inspect Notes");
  bindComputerTurn(thread, "next-human-turn");
  expect(computerTurnPlanForAuthority(thread, "next-human-turn")).toBeDefined();
});
