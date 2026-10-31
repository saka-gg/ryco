# Streaming Markdown blocks and prefix reuse

Ryco's shared web/Electron chat renderer splits a streaming message into settled
top-level blocks and a growing tail (`apps/web/src/markdown-blocks.ts`). Each
settled block is parsed and rendered once and keeps its React element objects,
so React skips it on every later update: only the tail is parsed, transformed
and rendered. The blocks are re-keyed and joined exactly as a single parse of
the whole text would produce them, so the DOM is the same and switching between
split and whole rendering updates it in place. Final messages use one full parse
and the normal highlighting path.

Inside the tail, the parser still reuses the pristine Markdown AST through a
closed top-level fence followed by a blank line
(`apps/web/src/markdown-incremental.ts`). It now runs for every streaming tail,
prose included; it matters where the block splitter stopped splitting.

## Split points

Synara's conservative boundaries: a column-0 ATX heading, fence opener or
thematic break directly after a blank line while no fence is open, and the first
non-blank line after a top-level fence closes. Paragraph breaks are not split
points, so a prose answer splits at its headings and breaks.

Lazy continuation lines, tabs in block structure, HTML blocks that may continue
past one line, list markers that may or may not interrupt a paragraph and empty
list items stop further splitting; the rest stays in the tail. Reference and
footnote definitions (they resolve across blocks), carriage returns and a byte
order mark keep the whole text in one block. Ryco renders no math, so `$$` is
text, unlike in Synara. A heading that closes a list item while the item's fence
is open is not a split point either: parsed on its own, that fence would keep
the blank lines before the heading. Upstream splits there; Ryco's every-prefix
parity test found the difference.

## What renderers read

Settled blocks only stay correct when everything their renderers read is part of
the cache key. The custom components map is: a changed file link set (basename
disambiguation can relabel an earlier link) re-parses every block. Web links do
not reach the components, so a new web link keeps them. The search highlight
numbers its hits in render order across the whole message, so a message with
search hits renders as one parse while it streams, like before.

## Verified upstream reference

- Synara [#1963](https://github.com/Emanuele-web04/synara/pull/1963), commit
  `bba7dcb8c` (v1.0.7): `streamingMarkdownBlocks.ts` and its tests, adapted with
  attribution in `THIRD_PARTY_NOTICES.md`. Upstream reports 18.6 ms to 0.7 ms per
  update for a 29 KB answer; not treated as a Ryco measurement.
- T3 Code [PR #11193](https://github.com/pingdotgg/t3code/pull/11193), merged as
  `a9dabbf100d1f6c0b2ed7b5e879d469ac14fd186`: the fence prefix cache, adapted
  with attribution in `THIRD_PARTY_NOTICES.md`, including support for tab
  whitespace after closing fences.

## Local evidence

A 30,000-character answer streamed 24 characters per update (1,249 updates) into
`ChatMarkdown` with `smoothStreaming={false}` in headless Chromium (vitest browser
mode). Render time is React Profiler `actualDuration` of the subtree per update,
parse included; block renders count paragraph-level renderer calls (`p`, `li`,
`blockquote`, `td`, `th`). Ranges are three runs each on a shared machine (the
block render counts are exact); the last quarter is updates past 22,500
characters.

| Answer              | Render ms, mean | Last quarter mean | p95       | Block renders per update |
| ------------------- | --------------- | ----------------- | --------- | ------------------------ |
| Prose, before       | 11.1–17.3       | 19.1–29.7         | 20.7–38.1 | 203                      |
| Prose, after        | 0.54–1.01       | 0.52–0.97         | 1.1–2.1   | 5.9                      |
| With fences, before | 3.2–4.2         | 5.0–5.3           | 5.6–7.7   | 151                      |
| With fences, after  | 0.42–0.59       | 0.41–0.68         | 0.9–1.3   | 3.8                      |

In the quietest run, splitting alone gave 1.39 ms (prose, 19.5 block renders)
and 0.89 ms (fences); keying the link metadata on file links only then removed
the full re-parse each new web link caused (0.54 ms, 5.9 block renders).

`markdown-blocks.test.tsx` counts parser input deterministically: the same kind
of 30 KB prose answer streamed in 24-character updates parses 373,059 characters
instead of 18,765,000 (98% less) and keeps every settled block's element objects.

Regression coverage streams every character prefix of a corpus (prose, lists,
headings, fences, tables, quotes, HTML, links, images, definitions, footnotes,
attachment manifests, CR and BOM) and 32,768 seeded fuzzed prefixes through the
builder, the tail prefix cache included, and compares element types, keys, props
and source positions with a single parse. Chromium tests check that settled
blocks neither re-render nor lose their DOM, that search hits are numbered across
the whole message, that a later file link relabels a settled one and that a late
definition resolves an earlier reference.

## Limits and integration

New syntax plugins with document-wide dependencies must requalify both the split
points and the prefix cache. A renderer that reads render-time state outside the
components map must either join the cache key or disable splitting, as the
search highlight does. Parsing stays proportional to the tail, but link scanning
and the smoothing still look at the whole text per update.
