import type { ProjectWriteFileInput } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  beginPreviewFileSave,
  PreviewFileSessionOwner,
  createPreviewFileEditSession,
  discardPreviewFileChanges,
  failPreviewFileSave,
  finishPreviewFileSave,
  isPreviewFileSessionDirty,
  reconcilePreviewFileSession,
  updatePreviewFileSessionContents,
  type PreviewFileDocument,
} from "./PreviewFileEditSession";

function document(overrides: Partial<PreviewFileDocument> = {}): PreviewFileDocument {
  return {
    key: "environment-local\u0000/repo\u0000src/app.ts",
    relativePath: "src/app.ts",
    contents: "const answer = 41;\n",
    version: "sha256:old",
    encoding: "utf8",
    lineEnding: "lf",
    ...overrides,
  };
}

describe("PreviewFileEditSession", () => {
  it("tracks edits and discards back to the saved contents", () => {
    const initial = createPreviewFileEditSession(document());
    const edited = updatePreviewFileSessionContents(initial, "const answer = 42;\n");

    expect(isPreviewFileSessionDirty(edited)).toBe(true);
    expect(discardPreviewFileChanges(edited)).toMatchObject({
      contents: "const answer = 41;\n",
      saveStatus: "idle",
    });
  });

  it("keeps edits made during a save dirty after the captured contents succeed", () => {
    const edited = updatePreviewFileSessionContents(
      createPreviewFileEditSession(document()),
      "const answer = 42;\n",
    );
    const saving = beginPreviewFileSave(edited);
    const editedAgain = updatePreviewFileSessionContents(saving, "const answer = 43;\n");
    const saved = finishPreviewFileSave(editedAgain, "const answer = 42;\n", "sha256:new");

    expect(saved.savedContents).toBe("const answer = 42;\n");
    expect(saved.contents).toBe("const answer = 43;\n");
    expect(isPreviewFileSessionDirty(saved)).toBe(true);
  });

  it("marks a dirty session conflicted when a different disk version arrives", () => {
    const edited = updatePreviewFileSessionContents(
      createPreviewFileEditSession(document()),
      "const answer = 42;\n",
    );
    const reconciled = reconcilePreviewFileSession(
      edited,
      document({ contents: "const answer = 99;\n", version: "sha256:external" }),
    );

    expect(reconciled).toMatchObject({
      contents: "const answer = 42;\n",
      saveStatus: "conflict",
      errorReason: "conflict",
    });
  });

  it("adopts a different disk version when the session is clean", () => {
    const initial = createPreviewFileEditSession(document());
    const reconciled = reconcilePreviewFileSession(
      initial,
      document({ contents: "const answer = 99;\n", version: "sha256:external" }),
    );

    expect(reconciled).toMatchObject({
      contents: "const answer = 99;\n",
      savedContents: "const answer = 99;\n",
      version: "sha256:external",
      saveStatus: "idle",
    });
  });

  it("does not overwrite a saving session during a background refresh", () => {
    const saving = beginPreviewFileSave(
      updatePreviewFileSessionContents(
        createPreviewFileEditSession(document()),
        "const answer = 42;\n",
      ),
    );

    expect(
      reconcilePreviewFileSession(
        saving,
        document({ contents: "const answer = 99;\n", version: "sha256:external" }),
      ),
    ).toBe(saving);
  });

  it("keeps typed contents and exposes a typed conflict after a failed save", () => {
    const edited = updatePreviewFileSessionContents(
      createPreviewFileEditSession(document()),
      "const answer = 42;\n",
    );
    const failed = failPreviewFileSave(edited, {
      reason: "conflict",
      message: "Reload before saving.",
    });

    expect(failed).toMatchObject({
      contents: "const answer = 42;\n",
      saveStatus: "conflict",
      errorMessage: "Reload before saving.",
    });
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function ownerHarness() {
  let disk = document();
  let authority: string | null = "connection-1";
  const publish = vi.fn();
  const release = vi.fn();
  const read = vi.fn(async () => disk);
  const write = vi.fn(async (input: Omit<ProjectWriteFileInput, "cwd">) => {
    if (input.expectedVersion !== disk.version)
      throw { reason: "conflict", message: "External edit" };
    disk = { ...disk, contents: input.contents, version: `${disk.version}:saved` };
    return { relativePath: disk.relativePath, version: disk.version };
  });
  const owner = new PreviewFileSessionOwner(document(), {
    authority: () => authority,
    read,
    write,
    publish,
    release,
  });
  const unsubscribe = owner.subscribe(() => {});
  return {
    owner,
    read,
    write,
    publish,
    release,
    unsubscribe,
    setDisk: (next: Partial<PreviewFileDocument>) => {
      disk = { ...disk, ...next };
    },
    setAuthority: (next: string | null) => {
      authority = next;
    },
  };
}

describe("PreviewFileSessionOwner", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("debounces rapid typing and serializes a drain through edits made during the write", async () => {
    const h = ownerHarness();
    const pending = deferred<{ relativePath: string; version: string }>();
    h.write.mockImplementationOnce(() => pending.promise);
    h.owner.change("a");
    await vi.advanceTimersByTimeAsync(300);
    h.owner.change("b");
    await vi.advanceTimersByTimeAsync(399);
    expect(h.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.write).toHaveBeenCalledTimes(1);
    h.owner.change("c");
    const firstDrain = h.owner.flush();
    expect(h.owner.flush()).toBe(firstDrain);
    h.setDisk({ contents: "b", version: "v2" });
    pending.resolve({ relativePath: "src/app.ts", version: "v2" });
    expect(await firstDrain).toBe(true);
    expect(h.write).toHaveBeenCalledTimes(2);
    expect(h.write.mock.calls[1]?.[0]).toMatchObject({ contents: "c", expectedVersion: "v2" });
    expect(h.owner.dirty).toBe(false);
    expect(Object.keys(h.publish.mock.calls.at(-1)![0]).toSorted()).toEqual([
      "contents",
      "encoding",
      "lineEnding",
      "relativePath",
      "version",
    ]);
  });

  it("keeps conflicts sticky while typing and only overwrites the freshly observed version", async () => {
    const h = ownerHarness();
    h.owner.change("draft");
    h.setDisk({ contents: "external", version: "v2", encoding: "utf8-bom", lineEnding: "crlf" });
    expect(await h.owner.flush()).toBe(false);
    h.owner.change("new draft");
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(h.owner.getSnapshot().saveStatus).toBe("conflict");
    expect(await h.owner.flush()).toBe(false);
    expect(await h.owner.flush(true, true)).toBe(true);
    expect(h.write.mock.calls[1]?.[0]).toMatchObject({
      contents: "new draft",
      expectedVersion: "v2",
      encoding: "utf8-bom",
      lineEnding: "crlf",
    });
  });

  it("retains the draft if overwrite discovers an unsupported external format, and discards offline", async () => {
    const h = ownerHarness();
    h.owner.change("draft");
    h.setDisk({ contents: "external", version: "v2", lineEnding: "mixed" });
    expect(await h.owner.flush(true, true)).toBe(false);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.owner.getSnapshot()).toMatchObject({ contents: "draft", errorReason: "unsupported" });
    h.setAuthority(null);
    expect(await h.owner.discard()).toBe(true);
    expect(h.owner.unsaved).toBe(false);
    expect(h.read).toHaveBeenCalledOnce();
  });

  it("accepts an overwrite whose fresh disk contents already match the draft", async () => {
    const h = ownerHarness();
    h.owner.change("draft");
    h.setDisk({ contents: "external", version: "v2" });
    await h.owner.flush();
    h.setDisk({ contents: "draft", version: "v3" });
    expect(await h.owner.flush(true, true)).toBe(true);
    expect(h.write).toHaveBeenCalledOnce();
    expect(h.owner.getSnapshot()).toMatchObject({
      saveStatus: "idle",
      version: "v3",
      savedContents: "draft",
    });
  });

  it("rejects a further external edit between overwrite's read and guarded write", async () => {
    const h = ownerHarness();
    h.owner.change("draft");
    h.read.mockImplementationOnce(async () => {
      h.setDisk({ version: "v3", contents: "second external edit" });
      return document({ version: "v2", contents: "first external edit" });
    });
    expect(await h.owner.flush(true, true)).toBe(false);
    expect(h.owner.getSnapshot()).toMatchObject({ contents: "draft", saveStatus: "conflict" });
  });

  it("reconciles a lost acknowledgement before retrying and never rewrites an already saved draft", async () => {
    const h = ownerHarness();
    h.write.mockImplementationOnce(async (input) => {
      h.setDisk({ contents: input.contents, version: "committed" });
      throw new Error("Disconnected before reply");
    });
    h.owner.change("draft");
    expect(await h.owner.flush()).toBe(false);
    h.setAuthority("connection-2");
    expect(await h.owner.flush()).toBe(false);
    expect(await h.owner.flush(true)).toBe(true);
    expect(h.read).toHaveBeenCalledOnce();
    expect(h.write).toHaveBeenCalledOnce();
    expect(h.owner.getSnapshot()).toMatchObject({
      version: "committed",
      savedContents: "draft",
      saveStatus: "idle",
    });
  });

  it("preserves an uncertain draft when disk changed and refuses automatic retries", async () => {
    const h = ownerHarness();
    h.write.mockRejectedValueOnce(new Error("Connection lost"));
    h.owner.change("draft");
    expect(await h.owner.flush()).toBe(false);
    h.setDisk({ version: "external", contents: "external" });
    expect(await h.owner.flush(true)).toBe(false);
    expect(h.owner.getSnapshot()).toMatchObject({ contents: "draft", saveStatus: "conflict" });
    expect(h.write).toHaveBeenCalledOnce();
  });

  it("fences late save replies from a replaced connection and reconciles on explicit retry", async () => {
    const h = ownerHarness();
    const pending = deferred<{ relativePath: string; version: string }>();
    h.write.mockImplementationOnce(() => pending.promise);
    h.owner.change("draft");
    const saving = h.owner.flush();
    await Promise.resolve();
    h.setAuthority("connection-2");
    h.setDisk({ version: "committed", contents: "draft" });
    pending.resolve({ relativePath: "src/app.ts", version: "committed" });
    expect(await saving).toBe(false);
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.owner.getSnapshot().version).toBe("sha256:old");
    expect(await h.owner.flush(true)).toBe(true);
    expect(h.write).toHaveBeenCalledOnce();
  });

  it("does not write without current mutation authority", async () => {
    const h = ownerHarness();
    h.setAuthority(null);
    h.owner.change("draft");
    expect(await h.owner.flush()).toBe(false);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.owner.getSnapshot().contents).toBe("draft");
  });

  it("does not erase typing during reload or publish a stale connection's read", async () => {
    const h = ownerHarness();
    const read = deferred<PreviewFileDocument>();
    h.read.mockImplementationOnce(() => read.promise);
    h.owner.change("draft");
    const reload = h.owner.reload();
    await Promise.resolve();
    h.owner.change("newer typing");
    read.resolve(document({ contents: "disk", version: "v2" }));
    expect(await reload).toBe(false);
    expect(h.owner.getSnapshot().contents).toBe("newer typing");
    expect(h.publish).not.toHaveBeenCalled();
    h.read.mockImplementationOnce(async () => {
      h.setAuthority("connection-2");
      return document({ contents: "disk", version: "v2" });
    });
    expect(await h.owner.reload()).toBe(false);
    expect(h.owner.getSnapshot().contents).toBe("newer typing");
  });

  it("discards offline during an uncertain write without IO and fences its late reply", async () => {
    const h = ownerHarness();
    const pending = deferred<{ relativePath: string; version: string }>();
    h.write.mockImplementationOnce(() => pending.promise);
    h.owner.change("draft");
    const saving = h.owner.flush();
    await Promise.resolve();
    h.setAuthority(null);
    expect(await h.owner.discard()).toBe(true);
    expect(h.owner.unsaved).toBe(false);
    expect(h.read).not.toHaveBeenCalled();
    expect(h.owner.getSnapshot().diskState).toBe("unknown");
    pending.resolve({ relativePath: "src/app.ts", version: "v2" });
    expect(await saving).toBe(false);
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.owner.getSnapshot().diskState).toBe("unknown");
    h.owner.change("cannot edit an unknown baseline");
    expect(h.owner.dirty).toBe(false);
  });

  it("abandons an already failed uncertain draft offline without reading", async () => {
    const h = ownerHarness();
    h.write.mockRejectedValueOnce(new Error("Connection lost"));
    h.owner.change("draft");
    await h.owner.flush();
    h.setAuthority(null);
    expect(await h.owner.discard()).toBe(true);
    expect(h.owner.unsaved).toBe(false);
    expect(h.read).not.toHaveBeenCalled();
    expect(h.owner.getSnapshot().diskState).toBe("unknown");
  });

  it("distinguishes local discard from reload and retains failed drafts on unmount", async () => {
    const h = ownerHarness();
    h.owner.change("draft");
    h.setDisk({ contents: "external", version: "v2" });
    expect(await h.owner.flush()).toBe(false);
    h.unsubscribe();
    await Promise.resolve();
    expect(h.release).not.toHaveBeenCalled();
    const unsubscribe = h.owner.subscribe(() => {});
    expect(await h.owner.discard()).toBe(true);
    expect(h.owner.getSnapshot().contents).toBe(document().contents);
    expect(h.read).not.toHaveBeenCalled();
    expect(await h.owner.reload()).toBe(true);
    expect(h.owner.getSnapshot().contents).toBe("external");
    unsubscribe();
    await Promise.resolve();
    expect(h.release).toHaveBeenCalledOnce();
  });
});
