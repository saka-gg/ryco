# Streaming Markdown prefix reuse

Ryco's shared web/Electron chat renderer now reuses the pristine Markdown AST
through a closed top-level fence followed by a blank line. Only the suffix is
reparsed; whole-document transforms and rendering still run. Each streaming
renderer owns one prefix cache, discarded when streaming ends. Final messages
use the original full parser and highlighting path.

Custom renderer component identities also stay stable when link destinations
are unchanged. This avoids remounting completed code blocks and workspace images
on prose updates. A changed link set still updates whole-message basename
disambiguation, and search highlighting remains document-wide.

## Verified upstream reference

- Reviewed [v0.0.37](https://github.com/pingdotgg/t3code/releases/tag/v0.0.37)
  (2026-08-31) as the requested release baseline; its notes do not contain this optimization.
- Inspected the code and MIT license for
  [PR #11193](https://github.com/pingdotgg/t3code/pull/11193), merged as
  `a9dabbf100d1f6c0b2ed7b5e879d469ac14fd186`.
- Verified that
  [v0.0.41-nightly.20260911.1533](https://github.com/pingdotgg/t3code/releases/tag/v0.0.41-nightly.20260911.1533)
  lists this PR; also checked subsequent release notes through
  [v0.0.41-nightly.20260912.1576](https://github.com/pingdotgg/t3code/releases/tag/v0.0.41-nightly.20260912.1576).
- Adapted the parser with attribution in `THIRD_PARTY_NOTICES.md`, including
  support for tab whitespace after closing fences. Upstream timing claims are
  not treated as Ryco measurements.

## Local evidence

`markdown-incremental.test.tsx` instruments the actual underlying parser input.
After warming a 6,432-character prefix (12 TypeScript fences, 30 lines each),
120 growing-prose updates parse **36,300 characters instead of 808,140**:
**95.51% less parser input**. Each update also checks HTML and the complete AST,
including source positions, against full-document parsing. A subsequent closed
fence advances the cache; the next parser input is only `end`.

This is a deterministic work measurement, not a wall-clock or overall rendering
speedup. Prefix validation, cloning, link scanning, transforms and React rendering
still have work proportional to document size.

Regression coverage compares every character prefix for incomplete inline syntax,
fences, tables, links, images, attachment manifests, lists, HTML, late references,
footnotes and unusual line endings. It also covers replacements, truncation,
retries, renderer isolation and downstream AST mutation. Chromium tests verify
DOM retention, one workspace-image fetch across updates, updated link labels and
search hits, attachment placeholder behavior and immediate final replacement.

Focused checks (Bun 1.4.0):

```sh
bun install --frozen-lockfile
bun run --cwd apps/web test src/markdown-incremental.test.tsx src/markdown-links.test.ts src/markdown-images.test.ts
bun run --cwd apps/web test:browser src/components/ChatMarkdown.browser.tsx
bun run --cwd apps/web typecheck
```

The focused suites pass 41 unit tests and 13 Chromium tests. Changed-file lint
passes with existing ref-access/effect warnings in `ChatMarkdown.tsx`; changed-file
format checks and `git diff --check` also pass.

## Limits and integration

Plain prose without fences uses the original parser. Unclosed, nested and
indented fences are not cache boundaries. Reference/footnote definitions, CR/CRLF
and BOM input fall back to full parsing. New syntax plugins with document-wide
dependencies must disable or requalify this optimization.

Concurrent Markdown changes may overlap `ChatMarkdown.tsx` and its browser tests;
dependency work may overlap `apps/web/package.json`, `bun.lock` and the notices.
Preserve the stable per-renderer plugin instance, pristine AST ownership and final
full-parse path when integrating. This change does not alter client-runtime,
hosted recovery/security, device authorization, boot ownership, native mobile or
the frozen web phone presentation tier. No merge or deployment was performed.
