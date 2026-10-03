/**
 * Per-file hunks for the pull request fixtures, ported verbatim from the PR
 * lab (`.docs/pr-lab/data.js`). Hunk headers carry exact line counts, so the
 * line numbers that review threads anchor to are real positions in the diff
 * that `fixtureDiff()` assembles from these entries.
 *
 * Test data only — never import this from app code.
 */

export type FixturePatchFileStatus = "added" | "modified";

export interface FixturePatchFile {
  readonly path: string;
  readonly status: FixturePatchFileStatus;
  /** The viewer's "Viewed" mark in the lab; `fixtureFilesViewed()` derives from it. */
  readonly viewed: "viewed" | "unviewed";
  /** Lockfiles and other generated output (tiered last in Files). */
  readonly generated?: boolean;
  /** Short SHAs of the commits that touched this file (commit-scoped diffs filter on them). */
  readonly commits: ReadonlyArray<string>;
  /** Hunks only: `@@ -a,b +c,d @@ section` headers followed by ` `, `+`, `-` lines. */
  readonly patch: string;
}

export const FIXTURE_PATCHES: Readonly<Record<number, ReadonlyArray<FixturePatchFile>>> = {
  703: [
    {
      path: "apps/web/src/components/pullRequests/stackLayers.logic.ts",
      status: "added",
      viewed: "viewed",
      commits: ["a41c9e2", "c3e81a0", "f2c7a19"],
      patch: `@@ -0,0 +1,58 @@
+import type {
+  SourceControlChangeRequestStack,
+  SourceControlChangeRequestStackEntry,
+} from "@ryco/contracts";
+
+export type StackLayerTone = "merged" | "ready" | "pending" | "blocked" | "draft";
+
+export interface StackLayer {
+  readonly entry: SourceControlChangeRequestStackEntry;
+  readonly tone: StackLayerTone;
+  /** Why the layer cannot merge yet, phrased for the merge box. */
+  readonly reason: string | null;
+}
+
+export interface StackMergePlan {
+  readonly through: number;
+  readonly layers: ReadonlyArray<StackLayer>;
+  readonly blockedBy: StackLayer | null;
+}
+
+/** Bottom → top: the order GitHub reports and the order a merge walks. */
+export function stackLayers(stack: SourceControlChangeRequestStack): ReadonlyArray<StackLayer> {
+  return stack.entries.map((entry) => ({ entry, ...assessLayer(entry) }));
+}
+
+function assessLayer(entry: SourceControlChangeRequestStackEntry) {
+  if (entry.state === "merged") return { tone: "merged" as const, reason: null };
+  if (entry.state === "closed") {
+    return { tone: "blocked" as const, reason: "Closed without merging" };
+  }
+  if (entry.isDraft) return { tone: "draft" as const, reason: "Still a draft" };
+  if (entry.mergeability === "conflicting") {
+    return { tone: "blocked" as const, reason: "Has merge conflicts" };
+  }
+  if (entry.mergeStateStatus === "BLOCKED" || entry.mergeStateStatus === "UNSTABLE") {
+    return { tone: "pending" as const, reason: "Waiting on reviews or checks" };
+  }
+  return { tone: "ready" as const, reason: null };
+}
+
+/** Merging "through" a layer lands every open layer at or below it, atomically. */
+export function planStackMerge(
+  stack: SourceControlChangeRequestStack,
+  through: number,
+): StackMergePlan {
+  const layers = stackLayers(stack).filter(
+    (layer) => layer.entry.position <= through && layer.tone !== "merged",
+  );
+  const target = layers.at(-1);
+  if (target?.entry.isDraft) return { through, layers, blockedBy: target };
+  const blockedBy =
+    layers.find((layer) => layer.tone === "blocked" || layer.tone === "pending") ?? null;
+  return { through, layers, blockedBy };
+}
+
+export function stackMergeLabel(plan: StackMergePlan): string {
+  return plan.layers.length > 1 ? "Merge stack (" + plan.layers.length + ")" : "Merge";
+}`,
    },
    {
      path: "apps/web/src/components/pullRequests/PullRequestStackRail.tsx",
      status: "added",
      viewed: "unviewed",
      commits: ["7d02f5b", "0b9d3a8"],
      patch: `@@ -0,0 +1,80 @@
+import { Link } from "@tanstack/react-router";
+import { GitMergeIcon, GitPullRequestDraftIcon, GitPullRequestIcon } from "lucide-react";
+import { memo, useCallback, useRef, type KeyboardEvent } from "react";
+
+import type { SourceControlChangeRequestStack } from "@ryco/contracts";
+import { cn } from "../../lib/utils";
+import { stackLayers, type StackLayerTone } from "./stackLayers.logic";
+
+const TONE_CLASS: Record<StackLayerTone, string> = {
+  merged: "text-violet-500",
+  ready: "text-emerald-500",
+  pending: "text-muted-foreground",
+  blocked: "text-rose-500",
+  draft: "text-muted-foreground/60",
+};
+
+export interface PullRequestStackRailProps {
+  readonly stack: SourceControlChangeRequestStack;
+  readonly current: number;
+  readonly onMergeThrough: (position: number) => void;
+}
+
+/** Top layer first, like the branches read in \`gh stack view\`. */
+export const PullRequestStackRail = memo(function PullRequestStackRail({
+  stack,
+  current,
+  onMergeThrough,
+}: PullRequestStackRailProps) {
+  const listRef = useRef<HTMLOListElement>(null);
+  const layers = stackLayers(stack).toReversed();
+  const onKeyDown = useCallback((event: KeyboardEvent<HTMLOListElement>) => {
+    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
+    const links = [...(listRef.current?.querySelectorAll("a") ?? [])];
+    const index = links.indexOf(document.activeElement as HTMLAnchorElement);
+    links[index + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
+    event.preventDefault();
+  }, []);
+
+  return (
+    <ol ref={listRef} aria-label={"Stack " + stack.number} onKeyDown={onKeyDown}>
+      {layers.map(({ entry, tone, reason }) => {
+        const selected = entry.number === current;
+        const Icon =
+          entry.state === "merged"
+            ? GitMergeIcon
+            : entry.isDraft
+              ? GitPullRequestDraftIcon
+              : GitPullRequestIcon;
+        return (
+          <li key={entry.number} className="group/layer relative">
+            <Link
+              to="/pull-requests/$number"
+              params={{ number: String(entry.number) }}
+              aria-selected={selected}
+              aria-label={"Layer " + entry.position + " of " + stack.size + ": " + entry.title}
+              title={reason ?? undefined}
+              className={cn(
+                "flex h-7 items-center gap-2 rounded-md px-2 text-xs transition-colors",
+                selected ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
+              )}
+            >
+              <Icon className={cn("size-3.5 shrink-0", TONE_CLASS[tone])} />
+              <span className="tabular-nums">#{entry.number}</span>
+              <span className="min-w-0 flex-1 truncate">{entry.title}</span>
+            </Link>
+            {selected && entry.position > 1 ? (
+              <button
+                type="button"
+                onClick={() => onMergeThrough(entry.position)}
+                className="absolute top-1 right-1 hidden rounded px-1.5 text-[11px] group-hover/layer:block"
+              >
+                Merge through here
+              </button>
+            ) : null}
+          </li>
+        );
+      })}
+    </ol>
+  );
+});`,
    },
    {
      path: "apps/web/src/components/pullRequests/PullRequestMergeBox.tsx",
      status: "modified",
      viewed: "unviewed",
      commits: ["c3e81a0", "f2c7a19"],
      patch: `@@ -1,12 +1,18 @@
 import { ChevronDownIcon, GitMergeIcon } from "lucide-react";
 import { useState } from "react";
 
+import type { SourceControlChangeRequestStack } from "@ryco/contracts";
 import { Button } from "../ui/button";
 import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
+import { ConfirmStackMerge } from "./ConfirmStackMerge";
 import { pullRequestMergeBlocker } from "./pullRequestStack.logic";
+import { planStackMerge, stackMergeLabel } from "./stackLayers.logic";
 
 export interface PullRequestMergeBoxProps {
   readonly detail: PullRequestDetailView;
   readonly capabilities: MergeCapabilitiesView;
   readonly onMerge: (method: MergeMethod) => void;
+  readonly stack?: SourceControlChangeRequestStack | undefined;
+  /** Layer position to merge through; defaults to the open pull request. */
+  readonly mergeThrough?: number | undefined;
 }
@@ -38,21 +44,26 @@ export function PullRequestMergeBox({
   detail,
   capabilities,
   onMerge,
+  stack,
+  mergeThrough,
 }: PullRequestMergeBoxProps) {
   const [method, setMethod] = useState(capabilities.defaultMethod);
-  const blocker = pullRequestMergeBlocker(detail);
+  const [confirming, setConfirming] = useState(false);
+  const plan = stack ? planStackMerge(stack, mergeThrough ?? detail.stackPosition) : null;
+  const blocker = plan?.blockedBy?.reason ?? pullRequestMergeBlocker(detail);
+  const label = plan ? stackMergeLabel(plan) : "Merge";
 
   return (
     <div className="flex items-center gap-2">
       <Button
         size="sm"
         disabled={blocker !== null}
-        onClick={() => onMerge(method)}
+        onClick={() => (plan && plan.layers.length > 1 ? setConfirming(true) : onMerge(method))}
       >
         <GitMergeIcon className="size-3.5" />
-        Merge
+        {label}
       </Button>
       <Menu>
         <MenuTrigger render={<Button size="icon-sm" variant="ghost" />}>
           <ChevronDownIcon className="size-3.5" />
         </MenuTrigger>
@@ -71,6 +82,18 @@ export function PullRequestMergeBox({
           ))}
         </MenuPopup>
       </Menu>
+      {plan && stack && confirming ? (
+        <ConfirmStackMerge
+          title={"Merge " + plan.layers.length + " pull requests into " + stack.baseRefName}
+          layers={plan.layers}
+          method={method}
+          onCancel={() => setConfirming(false)}
+          onConfirm={() => {
+            setConfirming(false);
+            onMerge(method);
+          }}
+        />
+      ) : null}
     </div>
   );
 }`,
    },
    {
      path: "apps/web/src/components/pullRequests/PullRequestPage.tsx",
      status: "modified",
      viewed: "unviewed",
      commits: ["7d02f5b", "c3e81a0"],
      patch: `@@ -14,17 +14,36 @@ import { PullRequestHeader } from "./PullRequestHeader";
 import { PullRequestMergeBox } from "./PullRequestMergeBox";
+import { PullRequestStackRail } from "./PullRequestStackRail";
 import { usePullRequestDetail } from "./usePullRequestDetail";
 
 export function PullRequestPage({ number }: { readonly number: number }) {
   const { detail, stack, merge } = usePullRequestDetail(number);
+  const [mergeThrough, setMergeThrough] = useState<number | undefined>(undefined);
   if (!detail) return <PullRequestDetailLoadingState />;
 
   return (
     <div className="flex h-full min-h-0 flex-col">
       <PullRequestHeader detail={detail} />
-      <div className="min-h-0 flex-1 overflow-y-auto">
-        <PullRequestTabs detail={detail} />
+      <div className="flex min-h-0 flex-1">
+        {stack ? (
+          <aside className="w-60 shrink-0 overflow-y-auto border-r border-border/70 p-2">
+            <PullRequestStackRail
+              stack={stack}
+              current={detail.number}
+              onMergeThrough={setMergeThrough}
+            />
+          </aside>
+        ) : null}
+        <div className="min-h-0 flex-1 overflow-y-auto">
+          <PullRequestTabs detail={detail} />
+        </div>
       </div>
-      <PullRequestMergeBox detail={detail} capabilities={detail.mergeCapabilities} onMerge={merge} />
+      <PullRequestMergeBox
+        detail={detail}
+        capabilities={detail.mergeCapabilities}
+        stack={stack}
+        mergeThrough={mergeThrough}
+        onMerge={merge}
+      />
     </div>
   );
 }`,
    },
    {
      path: "apps/web/src/routes/_chat.pull-requests.$number.tsx",
      status: "modified",
      viewed: "viewed",
      commits: ["7d02f5b"],
      patch: `@@ -1,10 +1,17 @@
 import { createFileRoute } from "@tanstack/react-router";
+import { Schema } from "effect";
 
 import { PullRequestPage } from "../components/pullRequests/PullRequestPage";
 
+const PullRequestSearch = Schema.Struct({
+  tab: Schema.optional(Schema.Literals(["conversation", "files", "checks", "commits"])),
+  layer: Schema.optional(Schema.NumberFromString),
+});
+
 export const Route = createFileRoute("/_chat/pull-requests/$number")({
+  validateSearch: Schema.standardSchemaV1(PullRequestSearch),
   component: function PullRequestRoute() {
     const { number } = Route.useParams();
     return <PullRequestPage number={Number(number)} />;
   },
 });`,
    },
    {
      path: "apps/web/src/rpc/sourceControlAtoms.ts",
      status: "modified",
      viewed: "unviewed",
      commits: ["c3e81a0"],
      patch: `@@ -417,6 +417,25 @@ export const changeRequestDetailBinding = defineQuery({
   staleTimeMs: 5 * 60_000,
   key: (input: ChangeRequestDetailInput) =>
     [input.environmentId, input.cwd, input.reference, input.fullContent ? "full" : "lite"].join("|"),
 });
 
+/**
+ * The whole stack moves together: merging through a layer retargets every PR
+ * above it, so a stack merge invalidates each layer's detail, not only the target.
+ */
+export function invalidateStackLayers(input: {
+  readonly environmentId: EnvironmentId;
+  readonly cwd: string;
+  readonly numbers: ReadonlyArray<number>;
+}) {
+  for (const number of input.numbers) {
+    changeRequestDetailBinding.refresh({
+      environmentId: input.environmentId,
+      cwd: input.cwd,
+      reference: String(number),
+      fullContent: true,
+    });
+  }
+}
+
 export const changeRequestDiffBinding = defineQuery({`,
    },
    {
      path: "packages/client-runtime/src/state/pull-request-stack.ts",
      status: "modified",
      viewed: "unviewed",
      commits: ["c3e81a0", "8e5d1c6"],
      patch: `@@ -1,6 +1,9 @@
 import type { SourceControlChangeRequestStack } from "@ryco/contracts";
+import { pluralize } from "@ryco/shared/text";
 
 export interface PullRequestStackSnapshot {
   readonly stack: SourceControlChangeRequestStack | null;
   readonly incomplete: boolean;
+  /** Head SHA per layer when the user looked; a merge refuses if any moved. */
+  readonly expectedHeads: ReadonlyMap<number, string>;
 }
@@ -24,2 +27,7 @@ export function stackSnapshot(
-  return { stack, incomplete };
+  const expectedHeads = new Map(stack?.entries.map((entry) => [entry.number, entry.headSha]));
+  return { stack, incomplete, expectedHeads };
 }
+
+export function stackSummaryLabel(stack: SourceControlChangeRequestStack): string {
+  return "Stack " + stack.number + " · " + pluralize(stack.size, "layer");
+}`,
    },
    {
      path: "packages/client-runtime/package.json",
      status: "modified",
      viewed: "viewed",
      commits: ["8e5d1c6"],
      patch: `@@ -18,4 +18,5 @@
   "dependencies": {
     "@ryco/contracts": "workspace:*",
+    "@ryco/shared": "workspace:*",
     "effect": "catalog:"
   },`,
    },
    {
      path: "bun.lock",
      status: "modified",
      viewed: "unviewed",
      generated: true,
      commits: ["8e5d1c6"],
      patch: `@@ -74,12 +74,13 @@
     "packages/client-runtime": {
       "name": "@ryco/client-runtime",
       "version": "0.9.0",
       "dependencies": {
         "@ryco/contracts": "workspace:*",
+        "@ryco/shared": "workspace:*",
         "effect": "catalog:",
       },
       "devDependencies": {
         "@effect/vitest": "catalog:",
         "vitest": "catalog:",
       },
     },`,
    },
    {
      path: "apps/web/src/components/pullRequests/stackLayers.logic.test.ts",
      status: "added",
      viewed: "unviewed",
      commits: ["a41c9e2", "4e1d0b2"],
      patch: `@@ -0,0 +1,60 @@
+import { describe, expect, it } from "vitest";
+import type { SourceControlChangeRequestStackEntry } from "@ryco/contracts";
+
+import { planStackMerge, stackLayers, stackMergeLabel } from "./stackLayers.logic";
+
+const entry = (
+  position: number,
+  patch: Partial<SourceControlChangeRequestStackEntry> = {},
+): SourceControlChangeRequestStackEntry => ({
+  position,
+  number: 700 + position,
+  title: "Layer " + position,
+  url: "https://github.com/ryco-labs/ryco/pull/" + (700 + position),
+  headRefName: "ryco/stack-" + position,
+  baseRefName: position === 1 ? "main" : "ryco/stack-" + (position - 1),
+  state: "open",
+  isDraft: false,
+  mergeability: "mergeable",
+  mergeStateStatus: "CLEAN",
+  ...patch,
+});
+const open = (position: number) => entry(position);
+const draft = (position: number) => entry(position, { isDraft: true, mergeStateStatus: "DRAFT" });
+const closed = (position: number) => entry(position, { state: "closed" });
+const stackOf = (entries: SourceControlChangeRequestStackEntry[]) => ({
+  number: 14,
+  size: entries.length,
+  position: 1,
+  baseRefName: "main",
+  entries,
+});
+
+describe("planStackMerge", () => {
+  it("merges through a ready layer", () => {
+    expect(planStackMerge(stackOf([open(1), open(2)]), 2).blockedBy).toBeNull();
+  });
+
+  it("refuses to merge through a draft layer below the target", () => {
+    const plan = planStackMerge(stackOf([open(1), draft(2), open(3)]), 3);
+    expect(plan.blockedBy?.entry.position).toBe(2);
+  });
+
+  it("refuses to merge through a closed layer in the middle", () => {
+    const plan = planStackMerge(stackOf([open(1), closed(2), open(3)]), 3);
+    expect(plan.blockedBy?.reason).toBe("Closed without merging");
+  });
+
+  it("labels a multi-layer merge with its size", () => {
+    expect(stackMergeLabel(planStackMerge(stackOf([open(1), open(2), open(3)]), 3))).toBe(
+      "Merge stack (3)",
+    );
+  });
+});
+
+describe("stackLayers", () => {
+  it("keeps GitHub's bottom → top order", () => {
+    const layers = stackLayers(stackOf([open(1), open(2), open(3)]));
+    expect(layers.map((layer) => layer.entry.position)).toEqual([1, 2, 3]);
+  });
+});`,
    },
    {
      path: "apps/web/src/components/pullRequests/PullRequestStackRail.browser.tsx",
      status: "added",
      viewed: "unviewed",
      commits: ["19be4f7", "0b9d3a8"],
      patch: `@@ -0,0 +1,34 @@
+import { page, userEvent } from "@vitest/browser/context";
+import { describe, expect, it, vi } from "vitest";
+
+import { renderWithRouter } from "../../test/renderWithRouter";
+import { PullRequestStackRail } from "./PullRequestStackRail";
+import { stackFixture } from "./__fixtures__/stack";
+
+describe("PullRequestStackRail", () => {
+  it("lists layers top-first and marks the open one", async () => {
+    await renderWithRouter(
+      <PullRequestStackRail stack={stackFixture} current={703} onMergeThrough={vi.fn()} />,
+    );
+    const links = page.getByRole("link").all();
+    expect(links.map((link) => link.element().textContent)).toEqual([
+      expect.stringContaining("#704"),
+      expect.stringContaining("#703"),
+      expect.stringContaining("#702"),
+      expect.stringContaining("#701"),
+    ]);
+    await expect.element(page.getByLabelText("Layer 3 of 4", { exact: false })).toHaveAttribute(
+      "aria-selected",
+      "true",
+    );
+  });
+
+  it("moves focus between layers with the arrow keys", async () => {
+    await renderWithRouter(
+      <PullRequestStackRail stack={stackFixture} current={703} onMergeThrough={vi.fn()} />,
+    );
+    await userEvent.click(page.getByText("#703"));
+    await userEvent.keyboard("{ArrowDown}");
+    await expect.element(page.getByLabelText("Layer 2 of 4", { exact: false })).toHaveFocus();
+  });
+});`,
    },
    {
      path: "apps/web/src/index.css",
      status: "modified",
      viewed: "unviewed",
      commits: ["7d02f5b"],
      patch: `@@ -1412,4 +1412,20 @@
   .chat-pane-header-out {
     animation: chat-pane-header-out var(--app-motion-duration-pane) var(--app-motion-ease) both;
   }
+
+  /* Stack rail: the layer you open slides its highlight, it never fades. */
+  .stack-rail-highlight {
+    transition:
+      translate var(--app-motion-duration-stack) var(--app-motion-spring-gentle),
+      height var(--app-motion-duration-stack) var(--app-motion-spring-gentle);
+  }
+
+  @keyframes stack-layer-merged {
+    from {
+      clip-path: inset(0 100% 0 0);
+    }
+    to {
+      clip-path: inset(0 0 0 0);
+    }
+  }
 }`,
    },
  ],
  701: [
    {
      path: "packages/contracts/src/sourceControl.ts",
      status: "modified",
      viewed: "unviewed",
      commits: ["d1e4a07"],
      patch: `@@ -29,7 +29,22 @@ export const SourceControlChangeRequestMergeability = Schema.Literals([
 ]);
 export type SourceControlChangeRequestMergeability =
   typeof SourceControlChangeRequestMergeability.Type;
 
+/**
+ * GitHub's mergeStateStatus, kept verbatim so the merge box can say *why* a
+ * layer is blocked. UNKNOWN decodes to null: it means "not computed yet".
+ */
+export const SourceControlMergeStateStatus = Schema.Literals([
+  "BEHIND",
+  "BLOCKED",
+  "CLEAN",
+  "DIRTY",
+  "DRAFT",
+  "HAS_HOOKS",
+  "UNSTABLE",
+]);
+export type SourceControlMergeStateStatus = typeof SourceControlMergeStateStatus.Type;
+
 /** Compact stack identity used by change-request list rows. */
 export const SourceControlChangeRequestStackSummary = Schema.Struct({
   number: PositiveInt,
@@ -43,12 +58,13 @@ export type SourceControlChangeRequestStackSummary =
 export const SourceControlChangeRequestStackEntry = Schema.Struct({
   position: PositiveInt,
   number: PositiveInt,
   title: TrimmedNonEmptyString,
   url: TrimmedNonEmptyString,
   headRefName: TrimmedNonEmptyString,
+  headSha: TrimmedNonEmptyString,
   baseRefName: TrimmedNonEmptyString,
   state: ChangeRequestState,
   isDraft: Schema.Boolean,
   mergeability: SourceControlChangeRequestMergeability,
-  mergeStateStatus: Schema.optional(Schema.NullOr(Schema.String)),
+  mergeStateStatus: Schema.NullOr(SourceControlMergeStateStatus),
 });`,
    },
    {
      path: "apps/server/src/sourceControl/gitHubPullRequestStacks.ts",
      status: "modified",
      viewed: "unviewed",
      commits: ["6c2b9f1"],
      patch: `@@ -16,13 +16,15 @@ export const GITHUB_PULL_REQUEST_STACK_QUERY = \`
         nodes {
           position
           pullRequest {
             number
             title
             url
             headRefName
+            headRefOid
             baseRefName
             state
             isDraft
             mergeable
+            mergeStateStatus
           }
         }
@@ -118,17 +120,34 @@ const RawStackEntrySchema = Schema.Struct({
-  mergeStateStatus: Schema.optional(Schema.NullOr(Schema.String)),
+  headRefOid: Schema.String,
+  mergeStateStatus: Schema.optionalWith(Schema.String, { nullable: true }),
 });
 
+const KNOWN_MERGE_STATES = new Set<string>([
+  "BEHIND",
+  "BLOCKED",
+  "CLEAN",
+  "DIRTY",
+  "DRAFT",
+  "HAS_HOOKS",
+  "UNSTABLE",
+]);
+
+/** UNKNOWN (or anything newer than this list) means "not computed yet". */
+function decodeMergeStateStatus(raw: string | undefined): SourceControlMergeStateStatus | null {
+  return raw && KNOWN_MERGE_STATES.has(raw) ? (raw as SourceControlMergeStateStatus) : null;
+}
+
 function toStackEntry(raw: typeof RawStackEntrySchema.Type): SourceControlChangeRequestStackEntry {
   return {
     position: raw.position,
     number: raw.pullRequest.number,
     title: raw.pullRequest.title,
     url: raw.pullRequest.url,
     headRefName: raw.pullRequest.headRefName,
+    headSha: raw.pullRequest.headRefOid,
     baseRefName: raw.pullRequest.baseRefName,
     state: toChangeRequestState(raw.pullRequest.state),
     isDraft: raw.pullRequest.isDraft,
     mergeability: toMergeability(raw.pullRequest.mergeable),
-    mergeStateStatus: raw.pullRequest.mergeStateStatus ?? null,
+    mergeStateStatus: decodeMergeStateStatus(raw.pullRequest.mergeStateStatus),
   };
 }`,
    },
    {
      path: "apps/server/src/sourceControl/gitHubPullRequestStacks.test.ts",
      status: "modified",
      viewed: "unviewed",
      commits: ["6c2b9f1", "0c4d8b5"],
      patch: `@@ -84,3 +84,22 @@ describe("normalizeGitHubPullRequestStackPages", () => {
     expect(stack.entries.map((entry) => entry.position)).toEqual([1, 2, 3]);
   });
+
+  it("keeps known merge states and drops UNKNOWN to null", () => {
+    const stack = normalizeGitHubPullRequestStackPages(
+      [
+        stackPage([
+          rawEntry(1, { mergeStateStatus: "CLEAN" }),
+          rawEntry(2, { mergeStateStatus: "UNKNOWN" }),
+          rawEntry(3, { mergeStateStatus: "BEHIND" }),
+        ]),
+      ],
+      2,
+    );
+    expect(stack.entries.map((entry) => entry.mergeStateStatus)).toEqual(["CLEAN", null, "BEHIND"]);
+  });
+
+  it("carries each layer's head SHA for the merge guard", () => {
+    const stack = normalizeGitHubPullRequestStackPages([stackPage([rawEntry(1), rawEntry(2)])], 1);
+    expect(stack.entries[1]?.headSha).toBe("b".repeat(40));
+  });
 });`,
    },
    {
      path: "packages/client-runtime/src/state/pull-request-stack.ts",
      status: "added",
      viewed: "viewed",
      commits: ["a8f03e6"],
      patch: `@@ -0,0 +1,29 @@
+import type { SourceControlChangeRequestStack } from "@ryco/contracts";
+
+export interface PullRequestStackSnapshot {
+  readonly stack: SourceControlChangeRequestStack | null;
+  readonly incomplete: boolean;
+}
+
+export const EMPTY_STACK_SNAPSHOT: PullRequestStackSnapshot = {
+  stack: null,
+  incomplete: false,
+};
+
+/**
+ * A stack is only trustworthy when every page decoded and the selected PR is
+ * one of its entries. Anything else is shown as "may be stale", never hidden.
+ */
+export function stackSnapshot(
+  stack: SourceControlChangeRequestStack | null,
+  selected: number,
+  metadataIncomplete: boolean,
+): PullRequestStackSnapshot {
+  const contains = stack?.entries.some((entry) => entry.number === selected) ?? false;
+  const incomplete = metadataIncomplete || (stack !== null && !contains);
+  return { stack, incomplete };
+}
+
+export function stackLayerAbove(stack: SourceControlChangeRequestStack, position: number) {
+  return stack.entries.find((entry) => entry.position === position + 1) ?? null;
+}`,
    },
    {
      path: "packages/client-runtime/package.json",
      status: "modified",
      viewed: "viewed",
      commits: ["57de2c4", "0c4d8b5"],
      patch: `@@ -18,7 +18,8 @@
   "dependencies": {
     "@ryco/contracts": "workspace:*",
     "effect": "catalog:"
   },
   "devDependencies": {
+    "@effect/vitest": "catalog:",
     "vitest": "catalog:"
   },
@@ -104,2 +105,3 @@
     "./state/pull-request-review": "./src/state/pull-request-review/index.ts",
+    "./state/pull-request-stack": "./src/state/pull-request-stack.ts",
     "./state/threads": "./src/state/threads/index.ts",`,
    },
    {
      path: "bun.lock",
      status: "modified",
      viewed: "unviewed",
      generated: true,
      commits: ["0c4d8b5"],
      patch: `@@ -74,11 +74,12 @@
     "packages/client-runtime": {
       "name": "@ryco/client-runtime",
       "version": "0.9.0",
       "dependencies": {
         "@ryco/contracts": "workspace:*",
         "effect": "catalog:",
       },
       "devDependencies": {
+        "@effect/vitest": "catalog:",
         "vitest": "catalog:",
       },
     },`,
    },
    {
      path: "packages/contracts/src/sourceControl.test.ts",
      status: "modified",
      viewed: "unviewed",
      commits: ["0c4d8b5"],
      patch: `@@ -211,3 +211,17 @@ describe("SourceControlChangeRequestStack", () => {
     expect(decoded.entries).toHaveLength(2);
   });
+
+  it("rejects an entry without a head SHA", () => {
+    const { headSha: _, ...withoutHead } = stackEntryFixture(1);
+    expect(() =>
+      Schema.decodeUnknownSync(SourceControlChangeRequestStackEntry)(withoutHead),
+    ).toThrow(/headSha/);
+  });
+
+  it("accepts a null mergeStateStatus while GitHub is still computing it", () => {
+    const entry = { ...stackEntryFixture(1), mergeStateStatus: null };
+    expect(Schema.decodeUnknownSync(SourceControlChangeRequestStackEntry)(entry)).toMatchObject({
+      mergeStateStatus: null,
+    });
+  });
 });`,
    },
    {
      path: "packages/shared/src/rpcAccessPolicy.ts",
      status: "modified",
      viewed: "viewed",
      commits: ["e2b6f90"],
      patch: `@@ -158,4 +158,5 @@ export const RPC_ACCESS_POLICY: Record<RpcMethod, RpcAccess> = {
   [WS_METHODS.sourceControlGetChangeRequestDetail]: "operator",
   [WS_METHODS.sourceControlGetChangeRequestDiff]: "operator",
+  [WS_METHODS.sourceControlGetChangeRequestStack]: "operator",
   [WS_METHODS.sourceControlMergeChangeRequest]: "operator",
   [WS_METHODS.sourceControlListWorkflowRuns]: "operator",`,
    },
  ],
  702: [
    {
      path: "apps/server/src/sourceControl/gitHubPullRequestStacks.ts",
      status: "modified",
      viewed: "unviewed",
      commits: ["b3e9d14", "f60a2c8", "8d4f1b6"],
      patch: `@@ -980,6 +980,22 @@ export const getPullRequestStack = Effect.fn("getPullRequestStack")(function* (
   const pages: Array<typeof RawStackPageSchema.Type> = [];
   let after: string | null = null;
-  const page = yield* cli.graphql(GITHUB_PULL_REQUEST_STACK_QUERY, { owner, name, number });
-  pages.push(yield* decodeStackPage(page));
+  for (let guard = 0; guard < MAX_STACK_PAGES; guard++) {
+    const page = yield* cli.graphql(GITHUB_PULL_REQUEST_STACK_QUERY, {
+      owner,
+      name,
+      number,
+      first: GITHUB_STACK_PAGE_SIZE,
+      after,
+    });
+    const decoded = yield* decodeStackPage(page);
+    pages.push(decoded);
+    const { hasNextPage, endCursor } = decoded.stack.entries.pageInfo;
+    if (!hasNextPage) break;
+    // A cursor that does not move would loop forever; GitHub has done it twice.
+    if (endCursor === after) {
+      return yield* new StackPagingError({ number, reason: "cursor did not advance" });
+    }
+    after = endCursor;
+  }
   return normalizeGitHubPullRequestStackPages(pages, number);
 });`,
    },
    {
      path: "apps/server/src/sourceControl/GitHubCli.ts",
      status: "modified",
      viewed: "unviewed",
      commits: ["c71e0a9"],
      patch: `@@ -1000,4 +1000,11 @@ export class GitHubCli extends Effect.Service<GitHubCli>()("GitHubCli", {
     graphql: (query: string, variables: Record<string, unknown>) =>
       executeGraphql(query, variables).pipe(
+        // Secondary rate limits come back as 403 with a Retry-After; one retry
+        // after that delay is enough for a stack read, more just piles up.
+        Effect.retry({
+          times: 1,
+          while: isSecondaryRateLimit,
+          schedule: Schedule.spaced(Duration.seconds(2)),
+        }),
         Effect.mapError(normalizeGitHubCliError),
       ),`,
    },
    {
      path: "apps/server/src/sourceControl/gitHubPullRequestStacks.test.ts",
      status: "modified",
      viewed: "unviewed",
      commits: ["f60a2c8"],
      patch: `@@ -102,1 +102,18 @@ describe("getPullRequestStack", () => {
+  it.effect("follows cursors until the last page", () =>
+    Effect.gen(function* () {
+      const cli = fakeGraphql([page([1, 2], "c1"), page([3, 4], "c2"), page([5], null)]);
+      const stack = yield* getPullRequestStack({ number: 703 }).pipe(provideCli(cli));
+      expect(stack.entries.map((entry) => entry.position)).toEqual([1, 2, 3, 4, 5]);
+      expect(cli.calls.map((call) => call.after)).toEqual([null, "c1", "c2"]);
+    }),
+  );
+
+  it.effect("fails instead of looping when the cursor does not advance", () =>
+    Effect.gen(function* () {
+      const cli = fakeGraphql([page([1, 2], "c1"), page([3, 4], "c1")]);
+      const error = yield* getPullRequestStack({ number: 703 }).pipe(provideCli(cli), Effect.flip);
+      expect(error).toBeInstanceOf(StackPagingError);
+    }),
+  );
+
 });`,
    },
    {
      path: "apps/server/src/ws/sourceControlRpc.ts",
      status: "modified",
      viewed: "viewed",
      commits: ["8d4f1b6"],
      patch: `@@ -212,4 +212,8 @@ export const makeSourceControlHandlers = Effect.gen(function* () {
       sourceControlRegistry.resolve({ cwd: input.cwd }).pipe(
         Effect.flatMap((provider) => provider.getChangeRequestDetail(input)),
+        // A stack read that fails must not take the whole detail down with it.
+        Effect.catchTag("StackPagingError", () =>
+          Effect.succeed({ ...detail, stack: null, stackMetadataIncomplete: true }),
+        ),
         Effect.tap(refreshStateForLinkedReference),
       ),`,
    },
  ],
  704: [
    {
      path: "apps/web/src/components/pullRequests/PullRequestStackRail.tsx",
      status: "modified",
      viewed: "unviewed",
      commits: ["e1a7c30", "92c5e81"],
      patch: `@@ -27,4 +27,16 @@ export const PullRequestStackRail = memo(function PullRequestStackRail({
 }: PullRequestStackRailProps) {
   const listRef = useRef<HTMLOListElement>(null);
   const layers = stackLayers(stack).toReversed();
+  const navigate = useNavigate();
+  const step = useCallback(
+    (delta: 1 | -1) => {
+      const index = layers.findIndex(({ entry }) => entry.number === current);
+      const next = layers[index + delta];
+      if (next) navigate({ to: "/pull-requests/$number", params: { number: String(next.entry.number) } });
+    },
+    [layers, current, navigate],
+  );
+  // J/K walk the stack, but never while you're typing or reading inside a file.
+  useHotkeys("j", () => step(-1), { enabled: (event) => !isInsideDiff(event.target) });
+  useHotkeys("k", () => step(1), { enabled: (event) => !isInsideDiff(event.target) });
   const onKeyDown = useCallback((event: KeyboardEvent<HTMLOListElement>) => {`,
    },
    {
      path: "apps/web/src/keybindings.ts",
      status: "modified",
      viewed: "unviewed",
      commits: ["4b9f2d7"],
      patch: `@@ -88,3 +88,6 @@ export const DEFAULT_KEYBINDINGS: ReadonlyArray<KeybindingDefinition> = [
   { command: "pullRequests.nextFile", key: "n", when: "pullRequestFilesFocus" },
   { command: "pullRequests.previousFile", key: "p", when: "pullRequestFilesFocus" },
+  { command: "pullRequests.toggleStackRail", key: "s", when: "pullRequestFocus && !inputFocus" },
+  { command: "pullRequests.stackLayerBelow", key: "j", when: "pullRequestFocus && !diffFocus" },
+  { command: "pullRequests.stackLayerAbove", key: "k", when: "pullRequestFocus && !diffFocus" },
 ];`,
    },
    {
      path: "apps/web/src/components/pullRequests/PullRequestStackRail.browser.tsx",
      status: "modified",
      viewed: "unviewed",
      commits: ["92c5e81"],
      patch: `@@ -32,3 +32,15 @@ describe("PullRequestStackRail", () => {
     await expect.element(page.getByLabelText("Layer 2 of 4", { exact: false })).toHaveFocus();
   });
+
+  it("ignores J/K while focus is inside the diff", async () => {
+    const { router } = await renderWithRouter(
+      <>
+        <PullRequestStackRail stack={stackFixture} current={703} onMergeThrough={vi.fn()} />
+        <div data-diff-file-path="a.ts" tabIndex={0}>diff</div>
+      </>,
+    );
+    await userEvent.click(page.getByText("diff"));
+    await userEvent.keyboard("j");
+    expect(router.state.location.pathname).toBe("/pull-requests/703");
+  });
 });`,
    },
  ],
  712: [
    {
      path: "apps/web/src/components/pullRequests/PullRequestDiffList.tsx",
      status: "added",
      viewed: "unviewed",
      commits: ["6a90c3d", "91d4e7b", "3e7b6d1"],
      patch: `@@ -0,0 +1,59 @@
+import { LegendList, type LegendListRef } from "@legendapp/list";
+import { memo, useMemo, useRef } from "react";
+
+import { useStickyFileHeader } from "../../hooks/useStickyFileHeader";
+import { DiffFileHeader } from "./DiffFileHeader";
+import { DiffLineRow } from "./DiffLineRow";
+import {
+  ESTIMATED_ROW_HEIGHT,
+  fileHeaderIndexes,
+  flattenDiffRows,
+  type DiffFileInput,
+  type DiffRow,
+} from "./diffRows.logic";
+
+export interface PullRequestDiffListProps {
+  readonly files: ReadonlyArray<DiffFileInput>;
+  readonly onToggleFile: (path: string) => void;
+}
+
+/**
+ * Every file of the PR in one virtual list. A 3,000-line diff used to mount
+ * 3,000 <div>s; this keeps roughly two screens of rows alive.
+ */
+export const PullRequestDiffList = memo(function PullRequestDiffList({
+  files,
+  onToggleFile,
+}: PullRequestDiffListProps) {
+  const listRef = useRef<LegendListRef>(null);
+  const rows = useMemo(() => flattenDiffRows(files), [files]);
+  const headers = useMemo(() => fileHeaderIndexes(rows), [rows]);
+  const sticky = useStickyFileHeader(listRef, headers);
+
+  return (
+    <div className="relative min-h-0 flex-1">
+      {sticky !== null ? (
+        <DiffFileHeader row={rows[sticky]} sticky onToggle={onToggleFile} />
+      ) : null}
+      <LegendList<DiffRow>
+        ref={listRef}
+        data={rows}
+        keyExtractor={(row) => row.key}
+        estimatedItemSize={ESTIMATED_ROW_HEIGHT}
+        drawDistance={1200}
+        recycleItems
+        getItemType={(row) => row.kind}
+        renderItem={({ item }) =>
+          item.kind === "file" ? (
+            <DiffFileHeader row={item} onToggle={onToggleFile} />
+          ) : item.kind === "hunk" ? (
+            <div className="diff-hunk-row">{item.header}</div>
+          ) : (
+            <DiffLineRow line={item.line} />
+          )
+        }
+        className="h-full"
+      />
+    </div>
+  );
+});`,
    },
    {
      path: "apps/web/src/components/pullRequests/diffRows.logic.ts",
      status: "added",
      viewed: "viewed",
      commits: ["2b8f1e0", "3e7b6d1"],
      patch: `@@ -0,0 +1,57 @@
+import type { DiffLine } from "../../lib/diffLines";
+
+export const ESTIMATED_ROW_HEIGHT = 20;
+
+export interface DiffFileInput {
+  readonly path: string;
+  readonly additions: number;
+  readonly deletions: number;
+  readonly lines: ReadonlyArray<DiffLine>;
+  readonly collapsed: boolean;
+}
+
+export type DiffRow =
+  | {
+      readonly kind: "file";
+      readonly key: string;
+      readonly path: string;
+      readonly additions: number;
+      readonly deletions: number;
+    }
+  | { readonly kind: "hunk"; readonly key: string; readonly path: string; readonly header: string }
+  | { readonly kind: "line"; readonly key: string; readonly path: string; readonly line: DiffLine };
+
+/**
+ * One flat list for the virtualizer: a header row per file, then its hunks and
+ * lines unless the file is collapsed. Sticky headers index into this list.
+ */
+export function flattenDiffRows(files: ReadonlyArray<DiffFileInput>): ReadonlyArray<DiffRow> {
+  const rows: DiffRow[] = [];
+  for (const file of files) {
+    rows.push({
+      kind: "file",
+      key: "file:" + file.path,
+      path: file.path,
+      additions: file.additions,
+      deletions: file.deletions,
+    });
+    if (file.collapsed) continue;
+    file.lines.forEach((line, index) => {
+      const key = file.path + ":" + index;
+      rows.push(
+        line.kind === "hunk"
+          ? { kind: "hunk", key, path: file.path, header: line.text }
+          : { kind: "line", key, path: file.path, line },
+      );
+    });
+  }
+  return rows;
+}
+
+export function fileHeaderIndexes(rows: ReadonlyArray<DiffRow>): ReadonlyArray<number> {
+  const indexes: number[] = [];
+  rows.forEach((row, index) => {
+    if (row.kind === "file") indexes.push(index);
+  });
+  return indexes;
+}`,
    },
    {
      path: "apps/web/src/components/pullRequests/PullRequestFilesTab.tsx",
      status: "modified",
      viewed: "unviewed",
      commits: ["6a90c3d", "c08a5f2"],
      patch: `@@ -9,8 +9,11 @@ import { usePullRequestFilesViewed } from "../projectExplorer/usePullRequestFilesViewed";
 import { Button } from "../ui/button";
 import { parseDiffLines } from "../../lib/diffLines";
+import { PullRequestDiffList } from "./PullRequestDiffList";
+import { usePullRequestFilesState } from "./usePullRequestFilesState";
 import { splitUnifiedDiffByFile } from "../../lib/unifiedDiffSplit";
 
 export function PullRequestFilesTab({ detail, active }: PullRequestFilesTabProps) {
-  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
+  // Lifted out of the tab so expanded files survive switching to Checks and back.
+  const { expanded, toggle } = usePullRequestFilesState(detail.number);
   const viewed = usePullRequestFilesViewed(detail, active);
   const diff = useChangeRequestDiff(detail, active && expanded.size > 0);
@@ -42,24 +45,19 @@ export function PullRequestFilesTab({ detail, active }: PullRequestFilesTabProps) {
-  const byFile = useMemo(() => (diff.data ? splitUnifiedDiffByFile(diff.data) : null), [diff.data]);
+  const files = useMemo(() => {
+    if (!diff.data) return [];
+    const byFile = splitUnifiedDiffByFile(diff.data);
+    return detail.files.map((file) => ({
+      path: file.path,
+      additions: file.additions,
+      deletions: file.deletions,
+      lines: parseDiffLines(byFile.get(file.path) ?? ""),
+      collapsed: !expanded.has(file.path),
+    }));
+  }, [detail.files, diff.data, expanded]);
 
   return (
     <div className="flex h-full min-h-0 flex-col">
       <PullRequestFilesToolbar viewed={viewed} total={detail.files.length} />
-      <div className="min-h-0 flex-1 overflow-y-auto">
-        {detail.files.map((file) => (
-          <PullRequestFileSection
-            key={file.path}
-            file={file}
-            expanded={expanded.has(file.path)}
-            onToggle={() => setExpanded((prev) => toggleSetEntry(prev, file.path))}
-          >
-            <pre className="overflow-x-auto font-mono text-xs">
-              {parseDiffLines(byFile?.get(file.path) ?? "").map((line, index) => (
-                <DiffLineRow key={index} line={line} />
-              ))}
-            </pre>
-          </PullRequestFileSection>
-        ))}
-      </div>
+      <PullRequestDiffList files={files} onToggleFile={toggle} />
     </div>
   );
 }`,
    },
    {
      path: "apps/web/src/hooks/useStickyFileHeader.ts",
      status: "added",
      viewed: "unviewed",
      commits: ["91d4e7b"],
      patch: `@@ -0,0 +1,29 @@
+import type { LegendListRef } from "@legendapp/list";
+import { type RefObject, useEffect, useState } from "react";
+
+/**
+ * Index of the file header that should stick to the top of the list: the last
+ * header at or above the first visible row. Null while the list is at the top.
+ */
+export function useStickyFileHeader(
+  listRef: RefObject<LegendListRef | null>,
+  headerIndexes: ReadonlyArray<number>,
+): number | null {
+  const [sticky, setSticky] = useState<number | null>(null);
+
+  useEffect(() => {
+    const list = listRef.current;
+    if (!list) return;
+    return list.addViewableItemsListener(({ start }) => {
+      if (start <= 0) return setSticky(null);
+      let found: number | null = null;
+      for (const index of headerIndexes) {
+        if (index > start) break;
+        found = index;
+      }
+      setSticky(found === start ? null : found);
+    });
+  }, [listRef, headerIndexes]);
+
+  return sticky;
+}`,
    },
    {
      path: "apps/web/src/lib/diffLines.ts",
      status: "modified",
      viewed: "viewed",
      commits: ["7f13e04"],
      patch: `@@ -1,6 +1,6 @@
 export interface DiffLine {
-  readonly kind: "hunk" | "context" | "add" | "remove";
+  readonly kind: "hunk" | "context" | "add" | "remove" | "meta";
   readonly oldLineNumber: number | null;
   readonly newLineNumber: number | null;
   readonly text: string;
 }
@@ -27,7 +27,12 @@ export function parseDiffLines(patch: string): DiffLine[] {
     if (raw.startsWith("@@")) {
       [oldLine, newLine] = parseHunkStart(raw);
       lines.push({ kind: "hunk", oldLineNumber: null, newLineNumber: null, text: raw });
       continue;
     }
+    // "\\ No newline at end of file" belongs to the line above, not the file.
+    if (raw.startsWith("\\\\")) {
+      lines.push({ kind: "meta", oldLineNumber: null, newLineNumber: null, text: raw.slice(2) });
+      continue;
+    }
     const marker = raw[0];
     const text = raw.slice(1);`,
    },
    {
      path: "apps/web/package.json",
      status: "modified",
      viewed: "viewed",
      commits: ["6a90c3d"],
      patch: `@@ -31,5 +31,6 @@
     "@base-ui-components/react": "1.0.0-beta.4",
     "@effect/atom-react": "catalog:",
+    "@legendapp/list": "3.0.0-beta.31",
     "@pierre/diffs": "1.4.1",
     "@ryco/client-runtime": "workspace:*",
     "@ryco/contracts": "workspace:*",`,
    },
    {
      path: "bun.lock",
      status: "modified",
      viewed: "unviewed",
      generated: true,
      commits: ["6a90c3d"],
      patch: `@@ -112,5 +112,6 @@
       "dependencies": {
         "@base-ui-components/react": "1.0.0-beta.4",
         "@effect/atom-react": "catalog:",
+        "@legendapp/list": "3.0.0-beta.31",
         "@pierre/diffs": "1.4.1",
         "@ryco/client-runtime": "workspace:*",
@@ -688,3 +689,5 @@
     "@jridgewell/trace-mapping": ["@jridgewell/trace-mapping@0.3.31", "", { "dependencies": { "@jridgewell/resolve-uri": "^3.1.0", "@jridgewell/sourcemap-codec": "^1.4.14" } }, "sha512-zzNR+SdQSDJzc8joaeP8QQoCQr8NuYx2dIIytl1QeBEZHJ9uW6hebsrYgbz8hJwUQao3TWCMtmfV8Nu1twOLAw=="],
 
+    "@legendapp/list": ["@legendapp/list@3.0.0-beta.31", "", { "dependencies": { "use-sync-external-store": "^1.5.0" }, "peerDependencies": { "react": "*" } }, "sha512-H4vJ6cQm2Tq0p8yJdYwL0aN3rX1uG8bK7sE2fZ5iP9oD3cV6tM1nR4hW8xA2yB5zC7dE9fG1hI3jK5lM7nO9pQ=="],
+
     "@napi-rs/wasm-runtime": ["@napi-rs/wasm-runtime@1.0.7", "", { "dependencies": { "@emnapi/core": "^1.5.0", "@emnapi/runtime": "^1.5.0", "@tybys/wasm-util": "^0.10.1" } }, "sha512-SeDnOO0Tk7Okiq6DbXmmBODgOAb9dp9gjlphokTUxmt8U3liIP1ZsozBahH69j/RJv+Rfs6IwUKHTgQYJ/HBAw=="],`,
    },
    {
      path: "apps/web/src/components/pullRequests/diffRows.logic.test.ts",
      status: "added",
      viewed: "unviewed",
      commits: ["a5d29c8"],
      patch: `@@ -0,0 +1,32 @@
+import { describe, expect, it } from "vitest";
+
+import { parseDiffLines } from "../../lib/diffLines";
+import { fileHeaderIndexes, flattenDiffRows } from "./diffRows.logic";
+
+const file = (path: string, collapsed = false) => ({
+  path,
+  additions: 2,
+  deletions: 1,
+  collapsed,
+  lines: parseDiffLines("@@ -1,2 +1,3 @@\\n context\\n-old\\n+new\\n+added"),
+});
+
+describe("flattenDiffRows", () => {
+  it("emits a header, then hunks and lines, per file", () => {
+    const rows = flattenDiffRows([file("a.ts"), file("b.ts")]);
+    expect(rows.map((row) => row.kind)).toEqual([
+      "file", "hunk", "line", "line", "line", "line",
+      "file", "hunk", "line", "line", "line", "line",
+    ]);
+  });
+
+  it("keeps only the header of a collapsed file", () => {
+    const rows = flattenDiffRows([file("a.ts", true), file("b.ts")]);
+    expect(rows.slice(0, 2).map((row) => row.kind)).toEqual(["file", "file"]);
+  });
+
+  it("indexes file headers for the sticky header", () => {
+    const rows = flattenDiffRows([file("a.ts"), file("b.ts", true), file("c.ts")]);
+    expect(fileHeaderIndexes(rows)).toEqual([0, 6, 7]);
+  });
+});`,
    },
    {
      path: "apps/web/src/components/pullRequests/PullRequestFilesTab.browser.tsx",
      status: "modified",
      viewed: "unviewed",
      commits: ["a5d29c8"],
      patch: `@@ -58,3 +58,19 @@ describe("PullRequestFilesTab", () => {
     await expect.element(page.getByText("2/5 viewed")).toBeVisible();
   });
+
+  it("mounts only the visible rows of a 3,000-line diff", async () => {
+    await renderFilesTab({ detail: largeDiffFixture, expandAll: true });
+    await expect.element(page.getByText("apps/server/src/ws.ts")).toBeVisible();
+    const mounted = document.querySelectorAll("[data-diff-row]").length;
+    expect(mounted).toBeGreaterThan(40);
+    expect(mounted).toBeLessThan(400);
+  });
+
+  it("keeps the current file header pinned while scrolling its lines", async () => {
+    await renderFilesTab({ detail: largeDiffFixture, expandAll: true });
+    await scrollDiffBy(2_400);
+    await expect
+      .element(page.getByTestId("diff-sticky-header"))
+      .toHaveTextContent("apps/server/src/ws.ts");
+  });
 });`,
    },
    {
      path: "apps/web/src/index.css",
      status: "modified",
      viewed: "unviewed",
      commits: ["91d4e7b"],
      patch: `@@ -1388,4 +1388,13 @@
   .diff-render-file {
     contain: layout paint;
   }
+
+  .diff-hunk-row {
+    padding-inline: 0.75rem;
+    font-family: var(--font-mono);
+    font-size: 11px;
+    line-height: 20px;
+    color: var(--muted-foreground);
+    background: color-mix(in srgb, var(--muted) 60%, transparent);
+  }
 }`,
    },
  ],
  688: [
    {
      path: ".github/workflows/release-dry-run.yml",
      status: "modified",
      viewed: "unviewed",
      commits: ["1b5f8d9"],
      patch: `@@ -21,12 +21,19 @@ jobs:
   desktop-mac:
     name: Desktop · macOS arm64
     runs-on: macos-15
+    environment: release-dry-run
     steps:
       - uses: actions/checkout@v5
       - uses: oven-sh/setup-bun@v2
         with:
           bun-version-file: package.json
       - run: bun install --frozen-lockfile
       - run: bun run build:desktop
       - name: Package DMG
         run: bun run --cwd apps/desktop dist --mac dmg --arm64
+      - name: Notarize (dry run)
+        run: bun run --cwd apps/desktop notarize release/Ryco-0.9.0-arm64.dmg --dry-run
+        env:
+          APPLE_TEAM_ID: \${{ secrets.APPLE_TEAM_ID }}
+          NOTARY_PROFILE: ryco-notary
+        secrets: inherit`,
    },
    {
      path: ".github/workflows/release.yml",
      status: "modified",
      viewed: "unviewed",
      commits: ["e4c6f02"],
      patch: `@@ -48,8 +48,23 @@ jobs:
       - name: Package DMG
         run: bun run --cwd apps/desktop dist --mac dmg --arm64
+      - name: Import signing certificate
+        uses: apple-actions/import-codesign-certs@v5
+        with:
+          p12-file-base64: \${{ secrets.MAC_CERT_P12 }}
+          p12-password: \${{ secrets.MAC_CERT_PASSWORD }}
+      - name: Store notary credentials
+        run: |
+          xcrun notarytool store-credentials ryco-notary \\
+            --apple-id "\${{ secrets.NOTARY_APPLE_ID }}" \\
+            --team-id "\${{ secrets.APPLE_TEAM_ID }}" \\
+            --password "\${{ secrets.NOTARY_PASSWORD }}"
+      - name: Notarize and staple
+        run: bun run --cwd apps/desktop notarize release/Ryco-\${{ needs.version.outputs.version }}-arm64.dmg
+        env:
+          APPLE_TEAM_ID: \${{ secrets.APPLE_TEAM_ID }}
       - name: Upload DMG
         uses: actions/upload-artifact@v4
         with:
           name: ryco-desktop-mac-arm64
           path: apps/desktop/release/*.dmg
-          retention-days: 7
+          retention-days: 14`,
    },
    {
      path: "apps/desktop/scripts/notarize.ts",
      status: "added",
      viewed: "unviewed",
      commits: ["9d7a1b3", "5f81a6d"],
      patch: `@@ -0,0 +1,58 @@
+import { notarize } from "@electron/notarize";
+import { execFile } from "node:child_process";
+import { stat } from "node:fs/promises";
+import { promisify } from "node:util";
+
+const run = promisify(execFile);
+
+export interface NotarizeOptions {
+  readonly dmgPath: string;
+  readonly keychainProfile: string;
+  readonly teamId: string;
+  readonly dryRun: boolean;
+}
+
+function log(message: string) {
+  console.log("[notarize] " + message);
+}
+
+/**
+ * notarytool reads credentials from a keychain profile created with
+ * \`xcrun notarytool store-credentials\`. A missing profile fails late and
+ * cryptically inside notarize(), so check it before uploading 180 MB.
+ */
+export async function verifyProfile(profile: string): Promise<void> {
+  log('verifying keychain profile "' + profile + '"…');
+  try {
+    await run("xcrun", ["notarytool", "history", "--keychain-profile", profile]);
+  } catch (cause) {
+    const message = cause instanceof Error ? cause.message : String(cause);
+    if (!message.includes("No Keychain password item found")) throw cause;
+    throw new Error("No Keychain password item found for profile: " + profile, { cause });
+  }
+}
+
+export function readOptions(env: NodeJS.ProcessEnv, argv: ReadonlyArray<string>): NotarizeOptions {
+  const teamId = env.APPLE_TEAM_ID;
+  if (!teamId) throw new Error("APPLE_TEAM_ID is not set");
+  return {
+    dmgPath: argv.find((arg) => arg.endsWith(".dmg")) ?? "release/Ryco-arm64.dmg",
+    keychainProfile: env.NOTARY_PROFILE ?? "ryco-notary",
+    teamId,
+    dryRun: argv.includes("--dry-run"),
+  };
+}
+
+async function main() {
+  const options = readOptions(process.env, process.argv.slice(2));
+  const { size } = await stat(options.dmgPath);
+  log(options.dmgPath.split("/").at(-1) + " (" + (size / 1e6).toFixed(1) + " MB)");
+  log("team ID: from APPLE_TEAM_ID");
+  // Dry runs still verify the profile so a broken secret fails on the PR.
+  await verifyProfile(options.keychainProfile);
+  if (options.dryRun) return log("dry run: skipping upload");
+  await notarize({ appPath: options.dmgPath, keychainProfile: options.keychainProfile });
+  log("notarized and stapled");
+}
+
+if (import.meta.main) await main();`,
    },
    {
      path: "apps/desktop/scripts/notarize.test.ts",
      status: "added",
      viewed: "unviewed",
      commits: ["9d7a1b3"],
      patch: `@@ -0,0 +1,19 @@
+import { describe, expect, it } from "vitest";
+
+import { readOptions } from "./notarize";
+
+describe("readOptions", () => {
+  it("requires APPLE_TEAM_ID", () => {
+    expect(() => readOptions({}, ["release/Ryco.dmg"])).toThrow("APPLE_TEAM_ID is not set");
+  });
+
+  it("defaults the keychain profile to ryco-notary", () => {
+    const options = readOptions({ APPLE_TEAM_ID: "TEAMID1234" }, ["release/Ryco.dmg"]);
+    expect(options.keychainProfile).toBe("ryco-notary");
+  });
+
+  it("treats --dry-run as a flag, not a path", () => {
+    const options = readOptions({ APPLE_TEAM_ID: "TEAMID1234" }, ["release/Ryco.dmg", "--dry-run"]);
+    expect(options).toMatchObject({ dmgPath: "release/Ryco.dmg", dryRun: true });
+  });
+});`,
    },
    {
      path: "apps/desktop/electron-builder.config.ts",
      status: "modified",
      viewed: "viewed",
      commits: ["70a3e4c"],
      patch: `@@ -22,8 +22,11 @@ export default {
   mac: {
     category: "public.app-category.developer-tools",
     target: [{ target: "dmg", arch: ["arm64", "x64"] }],
     hardenedRuntime: true,
-    notarize: false,
+    // Notarized by scripts/notarize.ts after the DMG is built, so the dry run
+    // can verify credentials without uploading anything.
+    notarize: false,
+    identity: process.env.CSC_NAME ?? null,
     entitlements: "build/entitlements.mac.plist",
     entitlementsInherit: "build/entitlements.mac.plist",
   },`,
    },
    {
      path: "apps/desktop/package.json",
      status: "modified",
      viewed: "viewed",
      commits: ["9d7a1b3"],
      patch: `@@ -9,7 +9,9 @@
     "build": "bun run build:main && bun run build:renderer",
     "dist": "electron-builder --config electron-builder.config.ts",
+    "notarize": "bun scripts/notarize.ts",
     "typecheck": "tsgo --noEmit"
   },
   "devDependencies": {
+    "@electron/notarize": "3.0.1",
     "electron": "38.2.1",
     "electron-builder": "26.0.12",`,
    },
    {
      path: "bun.lock",
      status: "modified",
      viewed: "unviewed",
      generated: true,
      commits: ["9d7a1b3"],
      patch: `@@ -41,8 +41,9 @@
     "apps/desktop": {
       "name": "@ryco/desktop",
       "version": "0.9.0",
       "devDependencies": {
+        "@electron/notarize": "3.0.1",
         "electron": "38.2.1",
         "electron-builder": "26.0.12",
       },
     },
@@ -402,3 +403,5 @@
     "@electron/get": ["@electron/get@2.0.3", "", { "dependencies": { "debug": "^4.1.1", "env-paths": "^2.2.0", "fs-extra": "^8.1.0", "got": "^11.8.5", "progress": "^2.0.3", "semver": "^6.2.0", "sumchecker": "^3.0.1" } }, "sha512-Qkzpg2s9GnVV2I2BjRksUi43U5e6+zaQMcjoJy0C+C5oxaKl+fmckGDQFtRpZpZV0NQekuZZ+tGz7EA9TVnQtQ=="],
 
+    "@electron/notarize": ["@electron/notarize@3.0.1", "", { "dependencies": { "debug": "^4.4.0", "promise-retry": "^2.0.1" } }, "sha512-5xzcOwvMGNjkSk7s0sPx4XcKWei9FYk4f2S5NkSorWW0ce5yktTOtlPa0W5yQHcREILh+C3JdH+t+M637g9TmQ=="],
+
     "@electron/osx-sign": ["@electron/osx-sign@1.3.3", "", { "dependencies": { "compare-version": "^0.1.2", "debug": "^4.3.4", "fs-extra": "^10.0.0", "isbinaryfile": "^4.0.8", "minimist": "^1.2.6", "plist": "^3.0.5" } }, "sha512-KZ8mhXvWv2rIEgMbWZ4y33bDHyUKMXnx4M0sTyPNK/vcB81ImdeY9Ggdqy0SWbMDgmbqyQ+phgejh6V3R2QuSg=="],`,
    },
    {
      path: "docs/release.md",
      status: "modified",
      viewed: "unviewed",
      commits: ["c9e2b57"],
      patch: `@@ -34,6 +34,17 @@ bun run release:smoke
 
 ## Desktop builds
 
-macOS DMGs are currently unsigned. Gatekeeper will ask users to confirm the first launch.
+macOS DMGs are signed with the Developer ID certificate and notarized in CI.
+
+### Secrets
+
+| Secret | Used by |
+| --- | --- |
+| \`MAC_CERT_P12\`, \`MAC_CERT_PASSWORD\` | Importing the signing certificate |
+| \`NOTARY_APPLE_ID\`, \`NOTARY_PASSWORD\` | \`notarytool store-credentials\` |
+| \`APPLE_TEAM_ID\` | Both |
+
+The dry run on pull requests verifies the keychain profile but never uploads.
+Pull requests from forks don't receive these secrets, so the step is skipped there.
 
 ## Mobile builds`,
    },
  ],
};
