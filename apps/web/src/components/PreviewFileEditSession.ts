import type {
  ProjectFileEncoding,
  ProjectFileLineEnding,
  ProjectReadFileResult,
  ProjectWriteFileFailureReason,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@ryco/contracts";

export type PreviewFileDocument = Pick<
  ProjectReadFileResult,
  "relativePath" | "contents" | "version" | "encoding" | "lineEnding"
> & {
  readonly key: string;
};

export type PreviewFileSaveStatus = "idle" | "saving" | "error" | "conflict";

export interface PreviewFileEditSession {
  readonly key: string;
  readonly relativePath: string;
  readonly contents: string;
  readonly savedContents: string;
  readonly version: string;
  readonly encoding: ProjectFileEncoding;
  readonly lineEnding: ProjectFileLineEnding;
  readonly saveStatus: PreviewFileSaveStatus;
  readonly errorReason: ProjectWriteFileFailureReason | null;
  readonly errorMessage: string | null;
  readonly diskState: "known" | "unknown";
}

export const PREVIEW_AUTOSAVE_DELAY_MS = 400;

export interface PreviewFileSessionIO {
  /** A stable token for the current authorized connection generation, or null. */
  readonly authority: () => string | object | null;
  readonly read: () => Promise<ProjectReadFileResult>;
  readonly write: (input: Omit<ProjectWriteFileInput, "cwd">) => Promise<ProjectWriteFileResult>;
  readonly publish: (file: ProjectReadFileResult) => void;
  readonly release: () => void;
}

/** Owns the existing edit session, including its only buffer and serialized writer.
 * Failed drafts remain in memory when their view unmounts. No background retries. */
export class PreviewFileSessionOwner {
  private session: PreviewFileEditSession;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private operation: Promise<boolean> | undefined;
  private discardedOperation: Promise<boolean> | undefined;
  private revision = 0;
  private operationGeneration = 0;
  private disposed = false;
  private uncertain: { contents: string; version: string } | null = null;

  constructor(
    document: PreviewFileDocument,
    private readonly io: PreviewFileSessionIO,
  ) {
    this.session = createPreviewFileEditSession(document);
  }

  getSnapshot = () => this.session;
  get pending() {
    return this.operation !== undefined;
  }
  get dirty() {
    return isPreviewFileSessionDirty(this.session);
  }
  get unsaved() {
    return this.dirty || this.pending || this.uncertain !== null;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    this.schedule();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.clearTimer();
      queueMicrotask(() => this.releaseIfUnused());
    };
  };

  private releaseIfUnused() {
    if (!this.listeners.size && !this.unsaved && !this.discardedOperation) {
      this.disposed = true;
      this.io.release();
    }
  }

  private commit(next: PreviewFileEditSession) {
    if (this.disposed || next === this.session) return;
    this.session = next;
    for (const listener of this.listeners) listener();
  }

  load(document: PreviewFileDocument) {
    if (
      this.pending ||
      this.discardedOperation ||
      this.uncertain ||
      this.session.saveStatus === "error"
    )
      return;
    this.commit(
      this.session.diskState === "unknown"
        ? createPreviewFileEditSession(document)
        : reconcilePreviewFileSession(this.session, document),
    );
  }

  markDeleted() {
    if (this.pending) return;
    this.clearTimer();
    this.commit(
      failPreviewFileSave(this.session, {
        reason: "deleted",
        message: "This file was removed from disk. Explorer will not recreate it.",
      }),
    );
  }

  change = (contents: string) => {
    if (this.session.diskState === "unknown" || contents === this.session.contents) return;
    this.revision++;
    this.commit(updatePreviewFileSessionContents(this.session, contents));
    this.schedule();
  };

  private schedule() {
    this.clearTimer();
    if (this.listeners.size && !this.pending && this.session.saveStatus === "idle" && this.dirty) {
      this.timer = setTimeout(() => void this.flush(), PREVIEW_AUTOSAVE_DELAY_MS);
    }
  }

  private clearTimer() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private assertAuthority(
    token: string | object | null,
    generation: number,
  ): asserts token is string | object {
    if (
      this.disposed ||
      generation !== this.operationGeneration ||
      token === null ||
      this.io.authority() !== token
    ) {
      throw new Error("Connection changed. Your draft is preserved; retry after reconnecting.");
    }
  }

  private run(action: (generation: number) => Promise<boolean>): Promise<boolean> {
    this.clearTimer();
    const generation = ++this.operationGeneration;
    this.operation = Promise.resolve()
      .then(() => action(generation))
      .catch((error: unknown) => {
        if (generation !== this.operationGeneration || this.disposed) return false;
        const failure = readPreviewFileSaveFailure(error);
        if (failure.reason !== "failed") this.uncertain = null;
        this.commit(failPreviewFileSave(this.session, failure));
        return false;
      })
      .finally(() => {
        if (generation !== this.operationGeneration || this.disposed) return;
        this.operation = undefined;
        this.commit({ ...this.session });
        this.schedule();
        this.releaseIfUnused();
      });
    return this.operation;
  }

  /** Explicit retry first reconciles any write whose reply could have been lost. */
  flush = (explicit = false, overwrite = false): Promise<boolean> => {
    this.clearTimer();
    if (this.operation) return this.operation;
    if (!explicit && this.session.saveStatus !== "idle") return Promise.resolve(false);
    if (!this.dirty && !this.uncertain && !overwrite) return Promise.resolve(true);
    return this.run(async (generation) => {
      const authority = this.io.authority();
      this.assertAuthority(authority, generation);
      if (this.uncertain || overwrite) {
        const disk = await this.io.read();
        this.assertAuthority(authority, generation);
        const uncertain = this.uncertain;
        if (
          uncertain &&
          disk.contents === uncertain.contents &&
          disk.encoding === this.session.encoding &&
          disk.lineEnding === this.session.lineEnding
        ) {
          this.commit(finishPreviewFileSave(this.session, uncertain.contents, disk.version));
          this.io.publish(disk);
          this.uncertain = null;
        } else if (uncertain && disk.version !== uncertain.version && !overwrite) {
          this.commit(
            failPreviewFileSave(this.session, {
              reason: "conflict",
              message:
                "The file changed while the save outcome was unknown. Your draft is preserved.",
            }),
          );
          return false;
        } else {
          this.uncertain = null;
          if (uncertain && disk.version === uncertain.version) {
            this.commit(finishPreviewFileSave(this.session, disk.contents, disk.version));
          }
        }
        if (overwrite) {
          // Preserve the current disk format and compare against exactly this read.
          this.commit(
            finishPreviewFileSave(
              {
                ...this.session,
                encoding: disk.encoding,
                lineEnding: disk.lineEnding,
              },
              disk.contents,
              disk.version,
            ),
          );
          this.io.publish(disk);
        }
      }
      if (this.session.saveStatus === "conflict" && !overwrite) return false;
      while (this.dirty) {
        this.assertAuthority(authority, generation);
        const captured = this.session;
        if (captured.lineEnding === "mixed") {
          this.commit(
            failPreviewFileSave(captured, {
              reason: "unsupported",
              message: "Mixed line endings cannot be saved from Explorer.",
            }),
          );
          return false;
        }
        this.commit(beginPreviewFileSave(captured));
        this.uncertain = { contents: captured.contents, version: captured.version };
        const result = await this.io.write({
          relativePath: captured.relativePath,
          contents: captured.contents,
          expectedVersion: captured.version,
          encoding: captured.encoding,
          lineEnding: captured.lineEnding,
        });
        this.assertAuthority(authority, generation);
        this.uncertain = null;
        this.commit(finishPreviewFileSave(this.session, captured.contents, result.version));
        this.io.publish({
          relativePath: captured.relativePath,
          contents: captured.contents,
          version: result.version,
          encoding: captured.encoding,
          lineEnding: captured.lineEnding,
        });
      }
      return true;
    });
  };

  /** Call only after confirming replacement of the visible draft. */
  reload = async (): Promise<boolean> => {
    this.clearTimer();
    const revision = this.revision;
    const pending = this.operation ?? this.discardedOperation;
    if (pending) await pending;
    if (revision !== this.revision || this.operation) return false;
    return this.run(async (generation) => {
      const authority = this.io.authority();
      this.assertAuthority(authority, generation);
      const disk = await this.io.read();
      this.assertAuthority(authority, generation);
      if (revision !== this.revision) return false;
      this.uncertain = null;
      this.commit(createPreviewFileEditSession({ ...disk, key: this.session.key }));
      this.io.publish(disk);
      return true;
    });
  };

  discard = (): Promise<boolean> => {
    this.clearTimer();
    // Discard abandons only the local draft. A delivered RPC cannot be undone;
    // fence its reply and leave disk state explicitly unknown without network IO.
    const unknown = this.pending || this.uncertain !== null || this.session.saveStatus !== "idle";
    this.operationGeneration++;
    const discarded = this.operation;
    if (discarded) {
      this.discardedOperation = discarded;
      void discarded.finally(() => {
        if (this.discardedOperation === discarded) this.discardedOperation = undefined;
        this.releaseIfUnused();
      });
    }
    this.operation = undefined;
    this.uncertain = null;
    this.commit({
      ...discardPreviewFileChanges(this.session),
      diskState: unknown ? "unknown" : this.session.diskState,
    });
    this.releaseIfUnused();
    return Promise.resolve(true);
  };

  disposeForTests() {
    this.clearTimer();
    this.disposed = true;
  }
}

export function createPreviewFileDocument(
  scope: { readonly environmentId: string; readonly cwd: string },
  file: ProjectReadFileResult,
): PreviewFileDocument {
  return {
    key: `${scope.environmentId}\u0000${scope.cwd}\u0000${file.relativePath}`,
    relativePath: file.relativePath,
    contents: file.contents,
    version: file.version,
    encoding: file.encoding,
    lineEnding: file.lineEnding,
  };
}

export function createPreviewFileEditSession(
  document: PreviewFileDocument,
): PreviewFileEditSession {
  return {
    ...document,
    savedContents: document.contents,
    diskState: "known",
    saveStatus: "idle",
    errorReason: null,
    errorMessage: null,
  };
}

export function isPreviewFileSessionDirty(session: PreviewFileEditSession | null): boolean {
  return session !== null && session.contents !== session.savedContents;
}

export function updatePreviewFileSessionContents(
  session: PreviewFileEditSession,
  contents: string,
): PreviewFileEditSession {
  if (contents === session.contents) return session;
  return {
    ...session,
    contents,
  };
}

export function beginPreviewFileSave(session: PreviewFileEditSession): PreviewFileEditSession {
  return {
    ...session,
    saveStatus: "saving",
    errorReason: null,
    errorMessage: null,
  };
}

export function finishPreviewFileSave(
  session: PreviewFileEditSession,
  savedContents: string,
  version: string,
): PreviewFileEditSession {
  return {
    ...session,
    savedContents,
    version,
    saveStatus: "idle",
    errorReason: null,
    errorMessage: null,
  };
}

export function failPreviewFileSave(
  session: PreviewFileEditSession,
  failure: {
    readonly reason: ProjectWriteFileFailureReason;
    readonly message: string;
  },
): PreviewFileEditSession {
  return {
    ...session,
    saveStatus:
      failure.reason === "conflict" || failure.reason === "deleted" ? "conflict" : "error",
    errorReason: failure.reason,
    errorMessage: failure.message,
  };
}

export function discardPreviewFileChanges(session: PreviewFileEditSession): PreviewFileEditSession {
  return {
    ...session,
    contents: session.savedContents,
    saveStatus: "idle",
    errorReason: null,
    errorMessage: null,
  };
}

export function reconcilePreviewFileSession(
  session: PreviewFileEditSession | null,
  document: PreviewFileDocument,
): PreviewFileEditSession {
  if (session === null || session.key !== document.key) {
    return createPreviewFileEditSession(document);
  }
  if (session.saveStatus === "saving" || session.version === document.version) {
    return session;
  }
  if (isPreviewFileSessionDirty(session)) {
    return failPreviewFileSave(session, {
      reason: "conflict",
      message: "This file changed on disk after it was opened. Reload it before saving.",
    });
  }
  return createPreviewFileEditSession(document);
}

export function readPreviewFileSaveFailure(error: unknown): {
  readonly reason: ProjectWriteFileFailureReason;
  readonly message: string;
} {
  const candidate = error as { readonly reason?: unknown; readonly message?: unknown } | null;
  const reason = candidate?.reason;
  return {
    reason:
      reason === "conflict" ||
      reason === "deleted" ||
      reason === "unsupported" ||
      reason === "failed"
        ? reason
        : "failed",
    message:
      typeof candidate?.message === "string" && candidate.message.trim().length > 0
        ? candidate.message
        : "Failed to save this file.",
  };
}
