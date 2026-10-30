import { describe, expect, it, vi } from "vitest";
import { ProviderInstanceId, ThreadId } from "@ryco/contracts";
import { EnvironmentId, MessageId } from "@ryco/contracts/base-schemas";
import { createQuoteCitation, serializeQuoteCitation } from "@ryco/shared/quoteCitations";
import {
  createSideChatStore,
  parseSideQuestionCommand,
  SIDE_CHAT_CONTINUE_COPY,
  sideChatThreadSeed,
  type SideChatApi,
} from "./index.ts";

const selection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6-astra",
  options: [],
};
function deferred() {
  let resolve!: (result: { requestId: string; answer: string }) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ requestId: string; answer: string }>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup() {
  const store = createSideChatStore();
  const next = deferred();
  const api: SideChatApi = {
    askSideQuestion: vi.fn(() => next.promise),
    cancelSideQuestion: vi.fn(async () => ({})),
  };
  store.getState().open("environment/thread", selection, "Why?");
  const ask = () =>
    store
      .getState()
      .ask("environment/thread", { threadId: ThreadId.make("thread"), requestId: "request", api });
  return {
    store,
    next,
    api,
    ask,
    chat: () => store.getState().chatsByThreadKey["environment/thread"]!,
  };
}
describe("ephemeral side conversations", () => {
  it("recognizes only the standalone btw command prefix", () => {
    expect(parseSideQuestionCommand(" /btw Why?\nReally? ")).toBe("Why?\nReally?");
    expect(parseSideQuestionCommand("/btw")).toBe("");
    expect(parseSideQuestionCommand("/btwhatever x")).toBeNull();
    expect(parseSideQuestionCommand("explain /btw")).toBeNull();
  });
  it("asks a quote chip's quote and comment as text, which Side's question field shows", () => {
    const token = serializeQuoteCitation(
      createQuoteCitation({
        source: { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") },
        messageId: MessageId.make("message"),
        selector: { exact: "你好，世界", prefix: "", suffix: "", start: 0, end: 5 },
        comment: "Which world?",
      }),
    );
    expect(parseSideQuestionCommand(`/btw what does this mean? ${token} `)).toBe(
      "what does this mean? [Quote 1]\n\n[Quote 1]\n> 你好，世界\nComment:\n  Which world?",
    );
  });
  it("toggles a side chat open on its own model, and minimizes it without stopping the answer", async () => {
    const { store, next, api, ask, chat } = setup();
    const pending = ask();
    expect(store.getState().toggle("environment/thread", { ...selection, model: "other" })).toBe(
      false,
    );
    expect(chat()).toMatchObject({ open: false, pending: { question: "Why?" } });
    expect(api.cancelSideQuestion).not.toHaveBeenCalled();
    // Reopening keeps the side chat's own model; only a new one takes the given selection.
    expect(store.getState().toggle("environment/thread", { ...selection, model: "other" })).toBe(
      true,
    );
    expect(chat()).toMatchObject({ open: true, modelSelection: selection });
    next.resolve({ requestId: "request", answer: "Because." });
    await pending;
    expect(chat().exchanges).toHaveLength(1);
    expect(store.getState().toggle("new/thread", { ...selection, model: "other" })).toBe(true);
    expect(store.getState().chatsByThreadKey["new/thread"]).toMatchObject({
      open: true,
      draft: "",
      exchanges: [],
      modelSelection: { model: "other" },
    });
  });
  it("seeds a continued thread with each answered question as plain lines", () => {
    expect(
      sideChatThreadSeed([
        { question: " Why does it retry? ", answer: "Because the node said so.\n\n- once\n" },
        { question: "How often?", answer: "Three times." },
      ]),
    ).toBe(
      [
        "From a side chat about this thread:",
        "",
        "Q: Why does it retry?",
        "A: Because the node said so.",
        "",
        "- once",
        "",
        "Q: How often?",
        "A: Three times.",
        "",
        "",
      ].join("\n"),
    );
    expect(SIDE_CHAT_CONTINUE_COPY.seedNote(1)).toContain("(1 question)");
    expect(SIDE_CHAT_CONTINUE_COPY.seedNote(3)).toContain("(3 questions)");
  });
  it("isolates concurrent threads and retains only completed successful side history", async () => {
    const { store, next, api, ask, chat } = setup();
    const pending = ask();
    store.getState().open("other/thread", { ...selection, model: "another" }, "Other question");
    expect(chat().exchanges).toEqual([]);
    expect(store.getState().chatsByThreadKey["other/thread"]?.pending).toBeNull();
    expect(api.askSideQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ history: [], modelSelection: selection }),
    );
    next.resolve({ requestId: "request", answer: "Because." });
    await pending;
    store.getState().setDraft("environment/thread", "And?");
    await ask();
    expect(api.askSideQuestion).toHaveBeenLastCalledWith(
      expect.objectContaining({ history: [{ question: "Why?", answer: "Because." }] }),
    );
  });
  it("cancels only the originating request and fences late success", async () => {
    const { store, next, api, ask, chat } = setup();
    const pending = ask();
    store.getState().cancel("environment/thread");
    expect(api.cancelSideQuestion).toHaveBeenCalledWith({ requestId: "request" });
    next.resolve({ requestId: "request", answer: "Too late" });
    await pending;
    expect(chat().exchanges).toEqual([]);
    expect(chat().draft).toBe("Why?");
  });
  it("disconnect fences stale replies and does not retry after reconnect", async () => {
    const { store, next, api, ask, chat } = setup();
    const pending = ask();
    store.getState().disconnect("environment/thread");
    store.getState().open("environment/thread", selection);
    next.reject(new Error("old transport failed"));
    await pending;
    expect(chat().error).toContain("Connection lost");
    expect(api.cancelSideQuestion).not.toHaveBeenCalled();
    expect(api.askSideQuestion).toHaveBeenCalledTimes(1);
  });
  it("keeps a newer draft on failure and permits explicit retry", async () => {
    const { store, next, ask, chat } = setup();
    const pending = ask();
    store.getState().setDraft("environment/thread", "Newer question");
    next.reject(new Error("Provider failed"));
    await pending;
    expect(chat().pending).toBeNull();
    expect(chat().error).toBe("Provider failed");
    expect(chat().draft).toBe("Newer question");
    expect(chat().exchanges).toEqual([]);
  });
  it("prevents duplicate sends and keeps independent model choices when reopening", async () => {
    const { store, next, api, ask, chat } = setup();
    const pending = ask();
    await ask();
    store.getState().close("environment/thread");
    store.getState().open("environment/thread", { ...selection, model: "changed primary" });
    expect(chat().modelSelection).toEqual(selection);
    expect(api.askSideQuestion).toHaveBeenCalledTimes(1);
    next.resolve({ requestId: "request", answer: "Done" });
    await pending;
  });
});

it("retains the failed quote alongside a newer draft and restores both explicitly", async () => {
  const { store, next, ask, chat } = setup();
  store.getState().setDraft("environment/thread", "Explain\n> selected code");
  const pending = ask();
  store.getState().setDraft("environment/thread", "Newer draft");
  next.reject(new Error("Failed"));
  await pending;
  expect(chat().draft).toBe("Newer draft");
  expect(chat().failedQuestion).toBe("Explain\n> selected code");
  store.getState().restoreFailedQuestion("environment/thread");
  expect(chat().draft).toBe("Newer draft\n\nExplain\n> selected code");
  expect(chat().failedQuestion).toBeNull();
});

it.each(["failure", "cancel", "disconnect"])(
  "requires resolving retained input before another ask after %s",
  async (mode) => {
    const { store, next, api, ask, chat } = setup();
    const pending = ask();
    store.getState().setDraft("environment/thread", "B");
    if (mode === "failure") next.reject(new Error("A failed"));
    else {
      if (mode === "cancel") store.getState().cancel("environment/thread");
      else store.getState().disconnect("environment/thread");
      next.resolve({ requestId: "request", answer: "Late" });
    }
    await pending;
    await ask();
    store.getState().setDraft("environment/thread", "C");
    store.getState().cancel("environment/thread");
    store.getState().disconnect("environment/thread");
    expect(api.askSideQuestion).toHaveBeenCalledOnce();
    expect(chat().draft).toBe("C");
    expect(chat().failedQuestion).toBe("Why?");
    store.getState().discardFailedQuestion("environment/thread");
    await ask();
    expect(api.askSideQuestion).toHaveBeenCalledTimes(2);
  },
);
