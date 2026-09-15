# Mermaid in messages and plans

Completed, explicitly closed `mermaid` and `mmd` fences render as diagrams in the
shared web/Electron chat renderer, including plans and other consumers of
`ChatMarkdown`. Streaming, incomplete, unsupported and rejected diagrams remain
plain code. Copy always uses the original source. A rendered diagram has a
keyboard-accessible source toggle.

The separate project-explorer Markdown renderer, native mobile and frozen web
phone presentation are unchanged. Diagram rendering never calls a server or
changes session, authorization, mutation readiness or hosted lifecycle state.

## Supported subset and security

The first version supports `flowchart`/`graph` and `sequenceDiagram`. Configuration
frontmatter and legacy directives are rejected, including malformed variants.
Custom styles/classes, interactive links/callbacks, HTML, entities, external URLs,
inline image/icon metadata, math and escaped input are excluded. The conservative
source filter also rejects these tokens inside labels/comments; source remains
available without rewriting it. This is intentionally not full Mermaid syntax.

`mermaidEngine.ts` initializes Mermaid in strict mode with HTML labels disabled
and app-owned resource limits. Initialization and rendering have one serialized
owner in `mermaidRenderer.ts`. A dedicated temporary measurement host is removed
on success or failure. Output passes through DOMPurify's SVG profile, excludes
active elements and references, and rejects external CSS resources. The result
is encoded as an SVG **image**, never inserted as live diagram markup into the
application. Generated local marker references and animation keyframes are
permitted; user CSS is not.

Mermaid 11.16.1 is pinned at the fix version for its published August 2026
configuration/CSS security advisories. DOMPurify 3.4.15 is an explicit dependency
and also satisfies Mermaid's sanitizer dependency. Recheck both projects'
security advisories before updating either dependency or broadening the subset.

## Resource and lifecycle limits

- 20,000 source characters; 1,000 characters per line/semicolon-delimited statement.
- 200 statements, 400 lexical word/number tokens, and Mermaid's 100-edge limit.
- 1,000,000 SVG characters and finite positive dimensions no larger than 20,000 px.
- 32 pending unique renders; identical source/theme requests share a job.
- 50 cached results, bounded to approximately 5 MiB including source keys and
  encoded images. Oversized entries bypass the shared LRU; failures also occupy
  bounded entries to avoid repeated layout on virtualized row remounts.

The engine loads only when an eligible block approaches the viewport. Source is
visible while loading or on error. Jobs yield to the browser event loop between
renders, skip abandoned consumers and discard stale results. The component is
keyed by source and light/dark theme. No content is persisted to browser storage
or passed through the service worker. Chunk-load failures retain code; remounting
can retry. Syntactic/layout failures remain cached until eviction or reload.

Bounds reduce work but do not provide a preemptive CPU deadline. Mermaid performs
DOM layout on the main thread; a promise timeout cannot interrupt it. The browser
qualification covers chains, dense graphs, sequences, over-budget edges and
hostile inputs. Additional diagram types or materially larger limits require
renewed CPU/security qualification. No worker or iframe runtime is introduced.

## Validation

Use the pinned Bun and install with `bun install --frozen-lockfile`, then:

```sh
bun run --cwd apps/web test src/lib/mermaidPolicy.test.ts src/lib/mermaidRenderer.test.ts src/markdown-incremental.test.tsx
bun run --cwd apps/web test:browser src/components/MermaidDiagram.browser.tsx src/components/ChatMarkdown.browser.tsx
bun run --cwd apps/web typecheck
bun run --cwd apps/web build
bun run measure:web-bundle
```

The browser tests use real Mermaid and DOMPurify, exercising output sanitation,
hostile labels/configuration, no hostile resource requests, rendering recovery,
source copy/toggle, visibility gating, streaming and phone exclusion. Unit tests
cover preflight limits, closed fences, queue/cache bounds and stale consumers.
Compare both total lazy assets and the recursive static import graph from the
startup `main` chunk: the bundle report's small HTML entry alone is insufficient
for startup-cost attribution.

## Reference

Behavior was independently implemented for Ryco after reviewing
[upstream PR #9621](https://github.com/pingdotgg/t3code/pull/9621), still open at
`5ff9709abd3df8db590467f317fd3375537fef01` on September 15, 2026. No upstream code
was copied. The expanded dialog and whole-selection clipboard behavior from
that proposal are outside this scope.
