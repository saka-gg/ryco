# Thread image gallery component

The web/desktop thread header opens the gallery for persisted threads. The modal
lives inside the thread pane context and uses the existing pane-focus boundary.
Losing pane focus closes it and releases gallery-owned attachment resources;
focus restoration never targets an inactive pane.

## Behavior

`ThreadImageGallery` opens an on-demand modal over persisted image attachments in
canonical loaded message history. It labels that coverage explicitly and orders
messages newest first, preserving image order within a message. Pages mount at
most 24 thumbnails. Older messages load only through an explicit action using
the existing history loader. No draft, Markdown, filesystem, or tool-output scan
is performed, and no attachment index is persisted.

Direct attachment URLs use lazy, asynchronous image decoding; these are original
images displayed at thumbnail size, not reduced-size thumbnail assets. Failed
thumbnails show a fallback. Expanded image failures retain the download action.
RPC-only images show metadata until selected and explicitly loaded. Only the
selected image loads, with navigation disabled during its read. Repeated clicks
cannot start concurrent loads for that owner. Navigation releases its blob; no
previous/next images are prefetched.

The shared web attachment-source hook preserves message-lifetime ownership for
message previews and selection-lifetime ownership for the gallery. It uses the
existing bounded authorized `readAttachmentBytes` transport, captures the read
function for an attempt, and rejects connection replacement between chunks.
Gallery reads additionally check the current lifecycle before every chunk and
before publishing a blob. Close, selection removal, thread/environment change,
socket replacement, hosted generation/role change, or unavailable connection
unmount the gallery-owned source and revoke its URL. Aborting stops further
chunks and ignores outstanding results; the existing RPC API cannot cancel a
chunk already dispatched to the server.

The gallery only observes existing connection status, hosted capability policy,
and authoritative hosted snapshot readiness. It never reconnects or publishes
readiness. Authorization, server endpoints, service-worker caching, native
presentation, and the frozen web phone tier are unchanged.

## Integration boundary

Import `ThreadImageGallery` from
`apps/web/src/components/chat/ThreadImageGallery.tsx` and provide:

- `scope`: the current persisted thread's `ScopedThreadRef`.
- `messages`: its canonical loaded `ChatMessage[]`, never composer/draft data.
- `open`, `onOpenChange`: controlled modal state, scoped to the active thread.
- `hasMoreBefore`: `activeThreadMessageHistory?.hasMoreBefore ?? false`.
- `isLoadingOlder`: `activeThreadMessageHistoryLoad?.status === "loading"`.
- `loadOlderError`: `activeThreadMessageHistoryLoad?.error ?? null`.
- `onLoadOlder`: the existing `handleLoadOlderMessages` callback.

The existing header prop is `onOpenThreadImages?: (() => void) | undefined`.
Only offer it for persisted threads in supported non-phone presentation tiers.
Reset open state when the scoped thread changes or the presentation becomes
phone. Keep the modal mounted while closed to allow its base dialog to restore
focus to the invoking action. Register its open state with the app's existing
pane/composer focus arbitration; do not introduce a competing global focus
handler. The independent component contains and restores modal focus using the
existing dialog primitive.

`ChatView` supplies this action and scopes open state to the active thread.
`ThreadImageGallery` gates its modal with `usePaneFocus()` and checks the live
pane-focus ref before publishing image bytes or restoring focus. It adds no
global keyboard listener. The existing expanded-image dialog uses
`usePaneEffect` for its global keyboard listener cleanup.

## Focused validation

Use the package-manager-pinned Bun version, and install with
`bun install --frozen-lockfile` when needed.

- `bun run --cwd packages/client-runtime test src/state/threads/threadImages.test.ts`
- `bun run --cwd apps/web test:browser src/components/chat/ThreadImageGallery.browser.tsx src/components/chat/useThreadImageReadScope.browser.tsx src/components/chat/MessageAttachments.browser.tsx`
- `bun run --cwd packages/client-runtime typecheck`
- `bun run --cwd apps/web typecheck`
- `bun run --cwd apps/web test:browser src/components/ChatView.browser.tsx -t "thread gallery|pane focus|pane grid"`
- Format/lint only the changed files.

Component checks cover bounded pages, identity and removal, loaded-history copy,
explicit older loading, lazy direct images, direct-image failure/downloads, RPC
retry/single-owner loading, close/scope supersession, blob cleanup, lifecycle
fencing, keyboard navigation, focus containment/restoration, and tablet/desktop
layout. Full-app gallery checks also exercise the real header action, history RPC,
Escape focus restoration, and two-pane pending/loaded RPC cleanup. Existing
pane focus and grid checks run alongside them.

## Reference

Behavior was independently implemented after reviewing
[Poracode PR 683](https://github.com/Porabuild/Poracode/pull/683), merged September 3,
2026, at head `bc28cce32fc4c3161b979b3f26b48dac9efb3bc3`. No upstream code was copied.
The scope excludes its persistent dock and Markdown/tool image collection.
