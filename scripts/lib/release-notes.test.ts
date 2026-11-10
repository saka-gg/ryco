import { describe, expect, it } from "vite-plus/test";

import {
  RELEASE_NOTES_END_MARKER,
  RELEASE_NOTES_START_MARKER,
  buildReleaseNotesRequest,
  findReleaseNotes,
  mergeReleaseNotesIntoBody,
  parseGitLogSubjects,
  renderReleaseNotesMarkdown,
} from "./release-notes.ts";

const release = {
  version: "1.2.3",
  date: "November 9, 2026",
  dateTime: "2026-11-09",
  summary: "A summary.",
  highlights: [
    { title: "First", summary: "One." },
    { title: "Second", summary: "Two." },
  ],
  releaseUrl: "https://github.com/saka-gg/ryco/releases/tag/v1.2.3",
};

describe("release notes for GitHub releases", () => {
  it("finds a release with or without the leading v", () => {
    expect(findReleaseNotes("v1.2.3", [release])).toBe(release);
    expect(findReleaseNotes("1.2.3", [release])).toBe(release);
    expect(findReleaseNotes("1.2.4", [release])).toBeUndefined();
  });

  it("renders the summary and highlights between markers", () => {
    const section = renderReleaseNotesMarkdown(release);
    expect(section.startsWith(RELEASE_NOTES_START_MARKER)).toBe(true);
    expect(section.endsWith(RELEASE_NOTES_END_MARKER)).toBe(true);
    expect(section).toContain("## What's new in Ryco 1.2.3");
    expect(section).toContain("A summary.");
    expect(section).toContain("- **First.** One.");
    expect(section).toContain("- **Second.** Two.");
  });

  it("puts the notes above an existing body and replaces them on the next run", () => {
    const section = renderReleaseNotesMarkdown(release);
    const original = "## macOS install\n\nDrag it.\n\n## What's Changed\n* A thing";
    const merged = mergeReleaseNotesIntoBody(original, section);
    expect(merged.startsWith(section)).toBe(true);
    expect(merged).toContain(original);
    expect(mergeReleaseNotesIntoBody(merged, section)).toBe(merged);

    const updated = renderReleaseNotesMarkdown({ ...release, summary: "Better." });
    const replaced = mergeReleaseNotesIntoBody(merged, updated);
    expect(replaced).toContain("Better.");
    expect(replaced).not.toContain("A summary.");
    expect(replaced).toContain(original);
  });

  it("handles an empty body", () => {
    const section = renderReleaseNotesMarkdown(release);
    expect(mergeReleaseNotesIntoBody("", section)).toBe(`${section}\n`);
  });

  it("covers every shipped release", () => {
    expect(findReleaseNotes("0.1.44")?.highlights.length).toBeGreaterThan(0);
  });
});

describe("the release-notes request", () => {
  it("lists changes with pull request numbers and leaves out version bumps", () => {
    const commits = parseGitLogSubjects(
      [
        "aaa\u001fPhone: Git tools (#1147)",
        "bbb\u001fchore(release): prepare v0.1.43",
        "ccc\u001fA direct commit",
        "",
      ].join("\n"),
    );
    const request = buildReleaseNotesRequest({
      version: "v0.1.45",
      previousTag: "v0.1.44",
      headSha: "ddd",
      repository: "saka-gg/ryco",
      commits,
    });
    expect(request.version).toBe("0.1.45");
    expect(request.compareUrl).toBe("https://github.com/saka-gg/ryco/compare/v0.1.44...ddd");
    expect(request.changes).toEqual([
      { number: 1147, title: "Phone: Git tools", sha: "aaa" },
      { number: null, title: "A direct commit", sha: "ccc" },
    ]);
  });

  it("has no compare link for the first release", () => {
    expect(
      buildReleaseNotesRequest({
        version: "0.1.0",
        previousTag: null,
        headSha: "x",
        repository: "o/r",
        commits: [],
      }).compareUrl,
    ).toBeNull();
  });
});
