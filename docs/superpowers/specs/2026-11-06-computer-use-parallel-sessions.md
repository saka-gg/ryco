# Computer Use: parallel sessions (phase 2)

Goal: several chats can use the Mac at once when they work in different apps. Two sessions on the same
app take turns (bounded FIFO wait) instead of failing. Reads never wait behind another app's input.

## What the driver allows (cua 0.28.2 + Synara native patch rev 40)

Checked in the patched source (`crates/cua-driver/src/serve.rs`, `sdk_adapter.rs`,
`platform-macos/src/input/cancellation.rs`):

- The embedded daemon accepts many socket connections and serves each one in its own task. The host
  already opens one connection per request, so requests can run at the same time.
- Reads (`get_window_state`, `get_desktop_state`, accessibility reads, screenshots, `list_*`,
  `get_browser_state`) take no input lease. They can overlap with anything.
- Native input goes through one process-wide gate (`InputGate`), one per daemon:
  - **Exact semantic writes** (`set_value`, `select_text`, and `click`/`scroll`/`type_text` addressed by
    `element_token`/`element_index`, or `type_text` with `semantic_only`, never foreground) take a
    _concurrent_ lease keyed by `(pid, window_id)`. Several can run at once on different windows. A second
    one on the same window is refused (`native_input_busy`).
  - **Every other input** (pixel/coordinate clicks, keys, scroll, drag, `launch_app`, window and app
    changes, clipboard, all `browser_*` mutations) takes an _exclusive_ lease. It is refused while any
    other input, semantic or not, is in flight.
  - The gate refuses; it never waits. Two overlapping exclusive inputs make the second fail.
  - `interrupt_input` (Stop, Escape, disconnected caller) closes the gate for every session of the
    daemon and reopens it with a new epoch once all input drained.
- One daemon per generation is kept. Several daemons would each draw their own cursor overlay, post
  events without a shared gate, and need their own TCC-attributed process. Not worth it.

So true overlap is: reads with everything; semantic writes on different windows with each other.
Pixel and keyboard input from different sessions alternates action by action. Everything a tool call
does around the input (target resolution, settle waits, the screenshot that rides on the result, AX
reads) runs in parallel.

## Lane model

One scheduler, `packages/shared/src/computerLanes.ts`, used by the desktop host and by the server queue.
A request names _claims_: `(resource, shared | exclusive)`. A request starts when its claims are
compatible with everything running **and** with every earlier waiting request it conflicts with
(strict FIFO among conflicts, so a waiting exclusive request is not starved by later readers). It waits
with an abort signal and an optional timeout; the queue is bounded.

Resources: `desktop` (every request claims it), `input` (the driver gate, host only), `app:<key>`,
`window:<key>`, `browser:<thread>`.

| Request                                                        | Host claims                                           | Server claims             |
| -------------------------------------------------------------- | ----------------------------------------------------- | ------------------------- |
| Read / observation                                             | desktop S                                             | desktop S                 |
| Exact semantic write                                           | desktop S, input S, window:pid/window E               | desktop S, window E       |
| Background input to one app                                    | desktop S, input E                                    | desktop S, app E          |
| Browser call                                                   | desktop S, browser:thread E (+ input E for mutations) | (browser lane, unchanged) |
| Foreground, clipboard, drag, launch, window/app changes, Space | desktop E                                             | desktop E                 |

The host mirrors the driver exactly, so the driver never sees two conflicting leases and
`native_input_busy` cannot come from our own scheduling. The server's app/window lanes order calls
from the same thread; ownership across threads stays with the leases below. Nested server operations
run inline when the claims they need are already held, and fail ("cannot switch targets") otherwise.

## Ownership across conversations (server leases)

Unchanged rules: one conversation owns an app (or a window for semantic writes) until its turn ends
or 5 minutes idle; the desktop lease (foreground, clipboard, gestures) is whole-desktop. New: an agent
tool call whose claim conflicts with another conversation's live lease waits in FIFO order for up to
45 s (`COMPUTER_LEASE_WAIT_MS`) instead of failing at once. The wait sits at the claim site, after any
approval dialog and before dispatch, and gives back its lane while waiting (`yieldLanes`) so the owner
keeps working; afterwards the target is resolved and checked again. Waiters wake on every lease
release or eviction (one notify point) and at the conflicting lease's idle expiry. A timeout fails with
a retryable `computer_controlled_by_other_thread` error that names the app, never the other
conversation, and says nothing was sent. Stop, a revoked turn or shutdown end the wait at once.
Direct manager calls outside an agent tool call (pane input) still refuse at once, as before.

Server lane per tool call (`ComputerManager.agentToolLane`): observation tools take the read lane;
plain single-target background input (click, scroll, keys, type, set value, select, perform action)
on an exact window of a known pid takes that app's lane; everything else, and anything the classifier
cannot prove, keeps the whole desktop. Inner wrappers refuse (nothing sent) when the target resolves to
another pid than the lane was scheduled for.

## What stays exclusive or global

- Foreground delivery, `bring_to_front`, menus, clipboard, drag, launch, window/app visibility,
  Space reservations (the Space broker still blocks foreground and launch while a reservation exists:
  activating a window can switch Spaces under the reservation).
- Exact pid/window identity checks, stale-generation fences, no automatic foreground fallback.
- Physical Escape and losing the Escape listener interrupt everything and require fresh observation.
- Permission changes and driver death retire the generation for everyone.

## Scoped recovery

- `focus_restore_failed`: only the task whose action lost focus must observe again (its target is
  fenced). Fallback to the old global fence only when that target is unknown. Other sessions' queued
  work is no longer cancelled; reads already in flight are still refused as stale.
- Task Stop while that task's input is in flight: the native interrupt is still driver-wide (gate
  limit), but queued work of other sessions waits for the drain and then runs with the new epoch
  instead of being cancelled. Other sessions whose input was in flight get an uncertain result and must
  observe their own target again. Previews and shields of other sessions keep running.

## Preview

One frame tap per visible thread, at most 4 helper processes; the least recently updated tap is
evicted for a fifth. Hidden threads hold none. The "Preview paused while another task is using this
computer" state is no longer reported for the macOS beta.

## Failure and timeout behaviour

- Lane wait: cancelled by the caller signal, by Stop (generation change) and by close; the host
  replies `not-dispatched`. Queue limit: 64 waiting requests.
- Lease wait: 45 s, FIFO per target, retryable error with the app name.
- A driver transport failure or timeout still retires the generation; with several calls in flight
  they all fail, mutations as `dispatched-unknown`. Same contract as before, just more callers.
