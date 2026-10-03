import { describe, expect, it } from "vite-plus/test";

import {
  buildGlabApiInvocation,
  describeGitLabApiFailure,
  gitLabMergeRequestEndpoint,
  gitLabWrite,
  parseGitLabApiFailure,
  parseGitLabMergeRequestReference,
  withGitLabQuery,
} from "./gitLabApi.ts";

describe("parseGitLabMergeRequestReference", () => {
  it("addresses bare numbers to the checkout's project", () => {
    for (const reference of ["42", "!42", "#42", " 42 "]) {
      expect(parseGitLabMergeRequestReference(reference)).toEqual({
        projectPath: ":fullpath",
        iid: 42,
      });
    }
  });

  it("addresses a merge request URL to its own (sub)group project and host", () => {
    expect(
      parseGitLabMergeRequestReference(
        "https://gitlab.example.com/group/sub/project/-/merge_requests/133/diffs?diff_id=1",
      ),
    ).toEqual({
      projectPath: "group%2Fsub%2Fproject",
      iid: 133,
      hostname: "gitlab.example.com",
    });
  });

  it("rejects anything else", () => {
    for (const reference of [
      "",
      "feature/x",
      "0",
      "https://gitlab.com/a/b/-/issues/3",
      "ftp://x",
    ]) {
      expect(parseGitLabMergeRequestReference(reference)).toBeNull();
    }
  });
});

describe("withGitLabQuery", () => {
  it("encodes values, repeats arrays as key[]=, and skips absent values", () => {
    expect(
      withGitLabQuery("projects/:fullpath/repository/merge_base", {
        refs: ["main", "feature/a b"],
        missing: undefined,
        none: null,
        per_page: 100,
        resolved: true,
      }),
    ).toBe(
      "projects/:fullpath/repository/merge_base?refs[]=main&refs[]=feature%2Fa%20b&per_page=100&resolved=true",
    );
    expect(withGitLabQuery("a?x=1", { y: "2" })).toBe("a?x=1&y=2");
  });
});

describe("buildGlabApiInvocation", () => {
  const ref = { projectPath: ":fullpath", iid: 7 };

  it("reads without a body", () => {
    expect(buildGlabApiInvocation({ method: "GET", endpoint: "user" })).toEqual({
      args: ["api", "--method", "GET", "user"],
    });
  });

  it("sends JSON bodies over stdin with an explicit content type, never on argv", () => {
    const body = "A body with `code` and --flags\nand a second line";
    const invocation = buildGlabApiInvocation(
      gitLabWrite(ref, "POST", gitLabMergeRequestEndpoint(ref, "/notes"), { body }),
    );
    expect(invocation.args).toEqual([
      "api",
      "--method",
      "POST",
      "projects/:fullpath/merge_requests/7/notes",
      "--header",
      "Content-Type: application/json",
      "--input",
      "-",
    ]);
    expect(invocation.args.join(" ")).not.toContain("second line");
    expect(JSON.parse(invocation.stdin ?? "")).toEqual({ body });
  });

  it("targets the reference's host", () => {
    const hosted = { projectPath: "g%2Fp", iid: 1, hostname: "gitlab.example.com" };
    expect(buildGlabApiInvocation(gitLabWrite(hosted, "DELETE", "x")).args).toEqual([
      "api",
      "--hostname",
      "gitlab.example.com",
      "--method",
      "DELETE",
      "x",
    ]);
  });
});

describe("parseGitLabApiFailure", () => {
  // `glab api` prints GitLab's JSON error body to stdout and
  // `glab: <message> (HTTP <status>)` to stderr, exiting 1.
  it("reads the status and GitLab's message", () => {
    const failure = parseGitLabApiFailure({
      stdout: '{"message":"404 Project Not Found"}',
      stderr: "glab: 404 Project Not Found (HTTP 404)\n",
    });
    expect(failure).toEqual({ status: 404, message: "404 Project Not Found" });
    expect(describeGitLabApiFailure(failure)).toBe(
      "GitLab could not find it (HTTP 404): 404 Project Not Found.",
    );
  });

  it("keeps structured validation messages", () => {
    expect(
      parseGitLabApiFailure({
        stdout: '{"message":{"note":["can\'t be blank"]}}',
        stderr: "glab: 400 Bad Request (HTTP 400)",
      }),
    ).toEqual({ status: 400, message: '{"note":["can\'t be blank"]}' });
  });

  it("falls back to stderr when the request never reached GitLab", () => {
    const failure = parseGitLabApiFailure({ stdout: "", stderr: "glab: dial tcp: timeout" });
    expect(failure).toEqual({ status: null, message: "dial tcp: timeout" });
    expect(describeGitLabApiFailure(failure)).toBe("GitLab CLI command failed: dial tcp: timeout");
  });
});
