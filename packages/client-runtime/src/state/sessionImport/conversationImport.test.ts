import {
  ProviderDriverKind,
  ProviderInstanceId,
  type SessionImportCandidate,
} from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { SessionImportContinuationProvider } from "./continuation.ts";
import {
  buildConversationImportView,
  createConversationImportController,
  SESSION_IMPORT_NO_MODEL,
  SESSION_IMPORT_NO_PROVIDER,
  SESSION_IMPORT_STATUS_ALREADY_IMPORTED,
  SESSION_IMPORT_STATUS_QUARANTINED,
  sessionImportConversationCount,
  sessionImportStoreLabel,
  type ConversationImportInput,
  type SessionImportClient,
} from "./conversationImport.ts";

const key = (letter: string) => letter.repeat(64);
const model = (slug: string, isDefault = false) => ({
  slug,
  name: slug,
  isDefault,
  isCustom: false,
  capabilities: null,
});
const provider = (
  instanceId: string,
  overrides: Partial<SessionImportContinuationProvider> = {},
): SessionImportContinuationProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  models: [model("first"), model("default", true)],
  ...overrides,
});
const candidate = (
  letter: string,
  overrides: Partial<SessionImportCandidate> = {},
): SessionImportCandidate => ({
  key: key(letter),
  source: "codex",
  title: `Conversation ${letter}`,
  cwd: "/work",
  archived: false,
  messageCount: 2,
  importedThreadId: null,
  quarantined: false,
  ...overrides,
});
const unique = {
  state: "unique" as const,
  candidates: [{ id: "copy", messageCount: 2 }],
  nextCursor: null,
  adoptionToken: "proof",
  notice: "One copy is proven.",
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(items: SessionImportCandidate[] = [candidate("a"), candidate("b")]) {
  const calls = {
    sources: vi.fn(async ({ source }: { source: string }) => [
      {
        key: key("c"),
        label: "Default store",
        isDefault: true,
        instanceIds: [ProviderInstanceId.make(source === "codex" ? "codex" : "claude")],
      },
      {
        key: key("d"),
        label: "Custom store",
        isDefault: false,
        instanceIds: [ProviderInstanceId.make("other")],
      },
    ]),
    discover: vi.fn(async (_input: { offset: number; storeKey?: string }) => ({
      items,
      notices: ["A notice."],
      nextOffset: 50 as number | null,
    })),
    run: vi.fn(async (_input: { key: string }) => ({
      threadId: "thread" as never,
      alreadyImported: false,
    })),
    reconcile: vi.fn(async (_input: { cursor?: string }) => unique as never),
    adopt: vi.fn(async () => ({ threadId: "adopted" as never, alreadyImported: false })),
  };
  let lost = false;
  const controller = createConversationImportController();
  const input: ConversationImportInput = {
    allowed: true,
    client: () => {
      if (lost) throw new Error("Reconnect with owner access before importing.");
      return calls as unknown as SessionImportClient;
    },
    projects: [{ id: "project", name: "Project" }],
    providerOptions: [
      provider("codex"),
      provider("other", { models: [model("other-model")] }),
      provider("claude", { driver: ProviderDriverKind.make("claudeAgent") }),
    ],
  };
  const view = () => buildConversationImportView(controller.getSnapshot(), input);
  return {
    calls,
    controller,
    input,
    view,
    loseAccess: () => {
      lost = true;
    },
  };
}

async function ready(f: ReturnType<typeof fixture>) {
  f.controller.setInput(f.input);
  await flush();
  await f.controller.find();
}

describe("conversation import", () => {
  it("reads stores only once access is granted and offers who uses the active store", async () => {
    const f = fixture();
    expect(f.calls.sources).not.toHaveBeenCalled();
    expect(f.view().canFind).toBe(false);
    f.controller.setInput(f.input);
    await flush();
    expect(f.calls.sources).toHaveBeenCalledWith({ source: "codex" });
    expect(f.view().activeStore?.key).toBe(key("c"));
    expect(f.view().providers.map((entry) => entry.instanceId)).toEqual(["codex"]);
    expect(f.view().model?.slug).toBe("default");
    expect(f.view().canFind).toBe(true);
  });

  it("finds a page, appends the next and runs only importable selected items", async () => {
    const f = fixture([
      candidate("a"),
      candidate("b", { importedThreadId: "done" as never }),
      candidate("e", { quarantined: true }),
    ]);
    await ready(f);
    expect(f.calls.discover.mock.calls[0]![0]).toMatchObject({ offset: 0, storeKey: key("c") });
    expect(f.view().items.map((entry) => entry.status)).toEqual([
      null,
      SESSION_IMPORT_STATUS_ALREADY_IMPORTED,
      SESSION_IMPORT_STATUS_QUARANTINED,
    ]);
    f.controller.setSelected(key("b"), true);
    f.controller.setSelected(key("e"), true);
    expect(f.view().selectedCount).toBe(0);
    f.controller.setSelected(key("a"), true);
    expect(f.view().canRun).toBe(false);
    f.controller.setProject("project");
    expect(f.view().canRun).toBe(true);
    expect(f.view().importableCount).toBe(1);
    await f.controller.run();
    expect(f.calls.run).toHaveBeenCalledTimes(1);
    expect(f.calls.run.mock.calls[0]![0]).toMatchObject({
      key: key("a"),
      storeKey: key("c"),
      projectId: "project",
      modelSelection: { instanceId: "codex", model: "default" },
    });
    expect(f.view().items[0]!.status).toBe("Imported");
    expect(f.view().items[0]!.selectable).toBe(false);
    expect(f.view().importableCount).toBe(0);
    await f.controller.nextPage();
    expect(f.calls.discover.mock.calls[1]![0].offset).toBe(50);
    expect(f.view().items).toHaveLength(6);
    // A next page keeps what the first one found and did.
    expect(f.view().items[0]!.status).toBe("Imported");
  });

  it("reports a failed item and retries it without repeating completed ones", async () => {
    const f = fixture();
    f.calls.run
      .mockResolvedValueOnce({ threadId: "one" as never, alreadyImported: false })
      .mockRejectedValueOnce(new Error("Provider unavailable"));
    await ready(f);
    f.controller.setSelected(key("a"), true);
    f.controller.setSelected(key("b"), true);
    f.controller.setProject("project");
    await f.controller.run();
    expect(f.view().items.map((entry) => entry.status)).toEqual([
      "Imported",
      "Provider unavailable",
    ]);
    await f.controller.run();
    expect(f.calls.run).toHaveBeenCalledTimes(3);
    expect(f.calls.run.mock.calls[2]![0].key).toBe(key("b"));
  });

  it("stops a run once access is lost and keeps the reason on the item", async () => {
    const f = fixture();
    await ready(f);
    f.controller.setSelected(key("a"), true);
    f.controller.setProject("project");
    f.loseAccess();
    await f.controller.run();
    expect(f.view().items[0]!.status).toBe("Reconnect with owner access before importing.");
  });

  it("stops a running import at the item it reached once access is lost", async () => {
    const f = fixture();
    await ready(f);
    const first = deferred<{ threadId: never; alreadyImported: boolean }>();
    f.calls.run.mockReturnValueOnce(first.promise);
    f.controller.setSelected(key("a"), true);
    f.controller.setSelected(key("b"), true);
    f.controller.setProject("project");
    const running = f.controller.run();
    f.controller.setInput({ ...f.input, allowed: false });
    first.resolve({ threadId: "one" as never, alreadyImported: false });
    await running;
    expect(f.calls.run).toHaveBeenCalledTimes(1);
    expect(f.controller.getSnapshot().busy).toBe(false);
  });

  it("ignores answers from before access was lost", async () => {
    const f = fixture([candidate("a", { quarantined: true })]);
    await ready(f);
    const late = deferred<typeof unique>();
    f.calls.reconcile.mockReturnValueOnce(late.promise as never);
    const inspection = f.controller.inspect(key("a"));
    expect(f.controller.getSnapshot().busy).toBe(true);
    const offline = { ...f.input, allowed: false };
    f.controller.setInput(offline);
    expect(f.controller.getSnapshot().busy).toBe(false);
    const hidden = buildConversationImportView(f.controller.getSnapshot(), offline);
    expect(hidden.items).toEqual([]);
    expect(hidden.canFind).toBe(false);
    late.resolve(unique);
    await inspection;
    f.controller.setInput(f.input);
    await flush();
    expect(f.view().items[0]!.recovery).toBeNull();
    expect(f.calls.sources).toHaveBeenCalledTimes(2);
  });

  it("inspects bounded pages and adopts only a proven copy", async () => {
    const f = fixture([candidate("a", { quarantined: true })]);
    await ready(f);
    f.calls.reconcile.mockResolvedValueOnce({
      state: "scanning",
      candidates: [],
      nextCursor: "page-2",
      adoptionToken: null,
      notice: "Continue.",
    } as never);
    await f.controller.adopt(key("a"));
    expect(f.calls.adopt).not.toHaveBeenCalled();
    await f.controller.inspect(key("a"));
    expect(f.view().items[0]!.canAdopt).toBe(false);
    expect(f.view().items[0]!.canInspectNextPage).toBe(true);
    await f.controller.inspectNextPage(key("a"));
    expect(f.calls.reconcile.mock.calls[1]![0]).toMatchObject({ cursor: "page-2" });
    expect(f.view().items[0]!.canAdopt).toBe(true);
    await f.controller.adopt(key("a"));
    expect(f.calls.adopt).toHaveBeenCalledWith({
      source: "codex",
      key: key("a"),
      adoptionToken: "proof",
    });
    expect(f.view().items[0]).toMatchObject({
      status: SESSION_IMPORT_STATUS_ALREADY_IMPORTED,
      tone: "success",
      recovery: null,
    });
    expect(f.calls.run).not.toHaveBeenCalled();
  });

  it("keeps a failed inspection paused with its reason", async () => {
    const f = fixture([candidate("a", { quarantined: true })]);
    await ready(f);
    f.calls.reconcile.mockRejectedValueOnce(new Error("Node busy"));
    await f.controller.inspect(key("a"));
    expect(f.view().items[0]).toMatchObject({ status: "Node busy", tone: "warning" });
  });

  it("clears discovery and the continuation choice when the store or source changes", async () => {
    const f = fixture();
    await ready(f);
    f.controller.setSelected(key("a"), true);
    f.controller.setStore(key("d"));
    expect(f.view().items).toEqual([]);
    expect(f.view().selectedCount).toBe(0);
    expect(f.view().provider?.instanceId).toBe("other");
    await f.controller.find();
    expect(f.calls.discover.mock.calls[1]![0].storeKey).toBe(key("d"));
    f.controller.setInstance("other");
    f.controller.setSource("claudeAgent");
    expect(f.controller.getSnapshot()).toMatchObject({ storeKey: "", instanceId: "", items: [] });
    await flush();
    expect(f.view().provider?.instanceId).toBe("claude");
  });

  it("drops a late search after the store changed", async () => {
    const f = fixture();
    f.controller.setInput(f.input);
    await flush();
    const late = deferred<Awaited<ReturnType<typeof f.calls.discover>>>();
    f.calls.discover.mockReturnValueOnce(late.promise);
    const search = f.controller.find();
    f.controller.setStore(key("d"));
    late.resolve({ items: [candidate("a")], notices: [], nextOffset: null });
    await search;
    expect(f.view().items).toEqual([]);
    expect(f.view().busy).toBe(false);
  });

  it("says why nothing can continue and words counts and stores", () => {
    const f = fixture();
    expect(
      buildConversationImportView(f.controller.getSnapshot(), f.input).continuationStatus,
    ).toBe(SESSION_IMPORT_NO_PROVIDER);
    expect(
      buildConversationImportView(
        {
          ...f.controller.getSnapshot(),
          stores: [{ key: key("c"), label: "S", isDefault: true, instanceIds: ["codex" as never] }],
        },
        { ...f.input, providerOptions: [provider("codex", { models: [] })] },
      ).continuationStatus,
    ).toBe(SESSION_IMPORT_NO_MODEL);
    expect(sessionImportConversationCount(1)).toBe("1 conversation");
    expect(sessionImportConversationCount(3)).toBe("3 conversations");
    expect(
      sessionImportStoreLabel({ key: key("c"), label: "S", isDefault: false, instanceIds: [] }),
    ).toBe("S (no enabled continuation instance)");
  });

  it("forgets a chosen project the node no longer has", async () => {
    const f = fixture();
    await ready(f);
    f.controller.setSelected(key("a"), true);
    f.controller.setProject("gone");
    expect(f.view()).toMatchObject({ projectId: "", canRun: false });
  });
});
