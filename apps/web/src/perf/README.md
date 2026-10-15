# Client perf profiling

Ryco has opt-in client-side performance instrumentation for thread switches, sidebar interactions, and component render timing.

## Enable profiling

Set `VITE_RYCO_PERF_PROFILE=1` when running the web app or browser tests:

```bash
VITE_RYCO_PERF_PROFILE=1 bun run dev:web
```

```bash
VITE_RYCO_PERF_PROFILE=1 bun --filter @ryco/web run test:browser
```

When disabled, all mark helpers are no-ops and budget tests use mocked `Performance` objects.

## Marks and measures

| Interaction            | Click mark                        | First-paint mark                        | Measure name                |
| ---------------------- | --------------------------------- | --------------------------------------- | --------------------------- |
| Thread tab switch      | `ryco:tab-switch:click:<key>`     | `ryco:tab-switch:first-paint:<key>`     | `ryco:tab-switch:<key>`     |
| Sidebar project expand | `ryco:sidebar-expand:click:<key>` | `ryco:sidebar-expand:first-paint:<key>` | `ryco:sidebar-expand:<key>` |
| Component render       | `ryco:render:<label>:start:N`     | `ryco:render:<label>:end:N`             | `ryco:render:<label>#N`     |

Helpers live in `tabSwitchInstrumentation.ts`. Soft budgets are defined in `budgets.ts`.

## Startup marks

Startup phases are always recorded (no flag) as `ryco:startup:<phase>` marks by
`startupInstrumentation.ts`, in boot order:

| Phase                             | Meaning                                                                      |
| --------------------------------- | ---------------------------------------------------------------------------- |
| `root-before-load-start`/`-ready` | Root route `beforeLoad` (auth gate) started / resolved                       |
| `root-shell-module-ready`         | The shell chunk resolved inside `beforeLoad` (only when it was not loaded)   |
| `primary-ws-open`                 | Primary WebSocket opened                                                     |
| `primary-shell-frame-received`    | First shell-subscription frame off the wire, before JSON parse/Schema decode |
| `primary-shell-snapshot-received` | Decoded shell snapshot reached the connection supervisor                     |
| `primary-shell-usable`            | Snapshot written to the store (before React renders it)                      |
| `primary-sidebar-committed`       | React committed the shell with the bootstrapped primary environment          |
| `primary-shell-painted`           | The frame holding that commit was presented (rAF, then a task)               |
| `first-thread-painted`            | The frame holding the first committed routed thread view was presented       |

Derived measures (`ryco:startup:<name>`) include `primary-shell-decode`,
`primary-sidebar-commit`, `primary-shell-paint` and `primary-shell-painted`
(navigation start to the painted shell). The external harness
(`scripts/perf/browserProbe.ts`) records every `ryco:startup:*` measure per sample,
reports `shellPaintedMs` and the total boot long-task time (`longTaskTotalMs`), and
with `--cpu-profile <dir>` records a boot CPU profile per sample, summarized by
self time per source file (see `docs/performance-testing.md`).

`components/perf/RouteRevealThrottle.browser.tsx` guards the code-loading
patterns that keep React's 300 ms Suspense reveal throttle off navigation paths
(route-level `lazyRouteComponent`, `preloadableLazy` loaded in `beforeLoad`).

## Inspecting results in DevTools

```js
performance.getEntriesByType("measure").filter((entry) => entry.name.startsWith("ryco:"));
```

Rate summaries also emit to the console via `perfInstrumentation.ts` when profiling is enabled.

## Budget tests

Unit tests in `budgets.test.ts` validate budget evaluation logic without requiring a live browser.

Browser budget regression coverage lives in `components/perf/ClientPerfBudget.browser.tsx` and runs with the browser test suite when `VITE_RYCO_PERF_PROFILE=1`.

## Debugging memo churn during refactors

Use `useDevPropDiff(props, "ComponentName")` at the top of a memoized component body while refactoring hot paths (`MessagesTimeline`, `ChatComposer`, sidebar rows). It logs which prop identities changed between renders. Remove before merging unless the component is permanently instrumented.

Use `useRenderCounter("ComponentName")` for coarse render-count logging in dev builds.

### Phase 0.2 audit (2026-06-14)

Static prop-diff audit for hot-path components. Findings and Phase 2.1 follow-ups:

- `.plans/21-prop-diff-findings.md`

Top priorities: stabilize `ChatComposer` `onSend` (not `useCallback` today), split `MessagesTimeline` row context, memoize sidebar `orderedProjectThreadKeys`.

## Related docs

- Server traces and OTLP export: `docs/observability.md`
- Improvement roadmap: `.plans/21-concrete-improvement-roadmap.md`
