import type { VcsStatusResult } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  readRepositoryStatus,
  recordRepositoryFailure,
  recordRepositoryStatus,
  UNKNOWN_REPOSITORY_STATUS,
} from "./repositoryStatus";

// The repository status read behind the new-task and fork sheets: a failed refresh must end the
// "still checking" state instead of leaving callers waiting for as long as they are open.

const api = {};
const connection = {};
const scope = { api, connection, cwd: "/repo" };
const status = { isRepo: true } as VcsStatusResult;

describe("repository status read", () => {
  it("is unknown until something answers", () => {
    expect(readRepositoryStatus(null, scope)).toBe(UNKNOWN_REPOSITORY_STATUS);
    expect(UNKNOWN_REPOSITORY_STATUS).toEqual({ data: null, error: null });
  });

  it("records a failed refresh so callers stop waiting", () => {
    const error = new Error("git failed");
    const failed = recordRepositoryFailure(null, scope, error);
    expect(readRepositoryStatus(failed, { ...scope })).toEqual({ data: null, error });
  });

  it("keeps a status the stream already delivered when a refresh fails, and a status clears the failure", () => {
    const answered = recordRepositoryStatus(scope, status);
    const failed = recordRepositoryFailure(answered, scope, new Error("remote failed"));
    expect(readRepositoryStatus(failed, scope).data).toBe(status);
    expect(readRepositoryStatus(recordRepositoryStatus(scope, status), scope)).toEqual({
      data: status,
      error: null,
    });
  });

  it("never reports another connection's or folder's answer", () => {
    const answered = recordRepositoryStatus(scope, status);
    expect(readRepositoryStatus(answered, { ...scope, cwd: "/other" })).toBe(
      UNKNOWN_REPOSITORY_STATUS,
    );
    expect(readRepositoryStatus(answered, { ...scope, connection: {} })).toBe(
      UNKNOWN_REPOSITORY_STATUS,
    );
    const failedElsewhere = recordRepositoryFailure(
      recordRepositoryStatus({ ...scope, cwd: "/other" }, status),
      scope,
      new Error("git failed"),
    );
    expect(readRepositoryStatus(failedElsewhere, scope).data).toBeNull();
  });
});
