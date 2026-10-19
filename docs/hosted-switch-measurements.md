# Hosted switch measurements

A ledger of local-fixture measurements for switching between nodes in the hosted web app and for
loading a thread cold. Each section below is filled in by the measurement run that belongs to it;
numbers are generic and aggregate (medians with min-max over at least seven iterations), with the
fixture shape stated next to them. Hostnames, ids, logs and raw traces are not recorded here.

## Method

Measurements use the hosted profiles of the external performance harness described in
[Performance Testing](./performance-testing.md#hosted-node-switch-and-cold-load): `hosted-switch`,
`hosted-cold-load`, `hosted-compare`, `hosted-fixture`, `hosted-correlate` and `delay-proxy`, run
against a local fixture with a compatible Hub. State for every table: revision measured, number of
nodes and threads per node, one-way delay, Hub session version, thread cache on or off, cold or
visited profile, and iteration count.

## Baseline (base commit)

Revision `336dfabdb`: the hosted web bundle and the nodes are both built from it.

Setup, shared with "After wave 0" (both revisions were measured in the same session):

- Two nodes on one machine, with 4 projects and 120 threads, and 3 projects and 80 threads (157
  inbox rows once both nodes are visited). Hub session protocol version 2, Hub thread cache off,
  production hosted build with hidden source maps, headless Chromium at 1280×800, a fresh browser
  context for every run.
- `D` is a one-way delay that the delay proxy adds on both legs (browser to Hub and Hub to node). A
  browser-Hub round trip costs about `2·D`; a browser-node round trip through the Hub about `4·D`.
- Interleaved blocks in the order base commit, after wave 0, base commit, after wave 0. Each block
  restarts the Hub with that revision's bundle and runs that revision's nodes on their own homes.
  Within a block, every delay gets one `hosted-switch` run: 7 measured cross-node switches and 3
  same-node controls. At D = 0 and 40 an eighth cross-node switch and one same-node control are
  CPU-profiled and left out of the medians. At D = 0, 40 and 80 the block also runs five cold loads.
  Medians pool both blocks of a revision: 14 cross-node switches, 4 (D = 0, 40) or 6 (D = 20, 80)
  same-node controls, and 10 cold loads per delay. No switch or load timed out or failed.
- Other jobs ran on the machine (1-minute load average 5.8–14.9), which is why the revisions
  alternate.
- The switch probe expands collapsed inbox sections before every switch. On the base commit a node
  switch collapses the settled section of the node it switches to, which would otherwise hide the
  open node's rows from the same-node control.
- Everything runs on loopback over plain HTTP/1.1, where the browser opens at most six connections
  per origin. That limit dominates the cold-load numbers at D > 0 (see "Cold load"). Behind an
  HTTP/2 front end the same requests are multiplexed.

### Node switch

Cross-node switch, ms after the click, median (min–max), n = 14:

| D   | Click long task     | First frame | Content             | Writable            |
| --- | ------------------- | ----------- | ------------------- | ------------------- |
| 0   | 1,019 (950–1,234)   | 1,022       | 1,366 (1,038–1,720) | 1,504 (1,328–1,720) |
| 20  | 1,060 (1,031–1,186) | 1,066       | 1,612 (1,135–1,821) | 1,642 (1,606–1,821) |
| 40  | 1,042 (1,017–1,142) | 1,045       | 1,759 (1,108–1,916) | 1,766 (1,745–1,916) |
| 80  | 1,074 (1,005–1,165) | 1,078       | 2,058 (1,114–2,331) | 2,112 (2,053–2,331) |

The fastest switches show content at about 1.0–1.1 s, long before they are writable: the thread was
already in memory, and the read-only banner stays until the new channel is ready.

Same-node control (content and writable are equal):

| D   | Click long task | Content       | n   |
| --- | --------------- | ------------- | --- |
| 0   | 448 (356–505)   | 469 (376–526) | 4   |
| 20  | 501 (488–545)   | 526 (509–574) | 6   |
| 40  | 456 (384–562)   | 475 (398–590) | 4   |
| 80  | 508 (503–540)   | 536 (530–559) | 6   |

What the click long task spends its time on, from the CPU profiles of the profiled cross-node
switches (D = 0 and 40, both blocks; profiling stretches the task to 1,083–1,276 ms), as self time
inside the task:

- inbox row code (row presentation and the row component): 124–166 ms; all inbox sidebar code:
  148–195 ms;
- React DOM: 335–401 ms;
- Base UI (the tooltip, menu and floating hooks every row mounts): 342–410 ms.

The profiled same-node task takes 375–434 ms, with 42–58 ms of inbox row code.

### Localhost gap

At D = 0 the click long task ends at 1,019 ms (median). The Hub authenticates the new stream at
428 ms, so the open request leaves the browser during the long task. The node starts serving the
shell subscription at 1,335 ms, 314 ms after the long task. Of that gap, 259 ms (83%) are further
long tasks of 60–80 ms each (shell pages applied and the inbox rendered again), so the gap is mostly
long-task queueing. The remaining ~55 ms are the channel open, the end-to-end handshake and RPC
setup, whose round trips are close to zero on loopback. At D = 40 the gap is 555 ms: the same
~260 ms of long tasks plus the round trips.

### Cold load

A fresh context loads a thread of the first node. Times in ms from navigation start, n = 10;
first content and writable are equal:

| D   | First content       | Access check (session, directory) | Account socket opens | Shell snapshot received | Shell painted |
| --- | ------------------- | --------------------------------- | -------------------- | ----------------------- | ------------- |
| 0   | 788 (707–880)       | 137 to 247                        | 272                  | 372                     | 735           |
| 40  | 3,472 (3,463–3,515) | 299 to 2,446                      | 2,449                | 3,096                   | 3,436         |
| 80  | 6,176 (6,115–6,241) | 456 to 4,591                      | 4,594                | 5,796                   | 6,140         |

Serial round trips. The critical chain is: document, entry chunks, access check, account socket
(upgrade, then the Hub session), node channel open, end-to-end handshake, shell snapshot. That is 5
browser-Hub round trips and 3 browser-node round trips, or 22·D of delay. The measured cost is
larger: first content grows by 33.6 browser-Hub round trips (2·D each) from D = 0 to 40, and by
33.7 from D = 0 to 80. The difference is connection queueing:

- The boot gate prefetches the thread route's code as one burst of 151 module requests, sent just
  before the access check.
- On the six-connection pool the access check finishes only after that burst: 2.1 s at D = 40,
  although the Hub answers in under a millisecond.
- The account socket opens only after the access answer, so the whole relay sequence starts late.

A cold load makes about 240 requests (2.2–2.5 MiB). The harness's own `serialRoundTrips` (1 to 3)
starts from the last response before first content, which here is a late, lazily loaded chunk, so it
understates the chain. The chain above comes from the per-request and per-frame timeline of each
load.

## After wave 0

Revision: the base commit plus the first set of changes. They include the always-on node-switch
marks, cheaper inbox row clicks, channel opens on their own queue on the node, thread windows from
the read worker, idle streams without timers, fewer terminal wake-ups, and smaller boot and thread
route bundles. The fixture and the interleaved blocks are the ones described under "Baseline (base
commit)".

### Against the targets

Click long task of a cross-node switch (ms, n = 14). Target: at most 250 ms.

| D   | Base commit | After wave 0  | Delta | Result |
| --- | ----------- | ------------- | ----- | ------ |
| 0   | 1,019       | 180 (150–197) | -839  | met    |
| 20  | 1,060       | 178 (143–204) | -882  | met    |
| 40  | 1,042       | 190 (158–227) | -852  | met    |
| 80  | 1,074       | 185 (169–204) | -889  | met    |

Inbox rows self time in the click task (profiled switches at D = 0 and 40). Target: at most 30 ms.

| Code                                     | Base commit | After wave 0 | Result |
| ---------------------------------------- | ----------- | ------------ | ------ |
| Inbox row presentation and row component | 124–166     | 1.7–6.5      | met    |
| All inbox sidebar code                   | 148–195     | 14–20        | met    |
| React DOM                                | 335–401     | 53–89        |        |
| Base UI                                  | 342–410     | 42–60        |        |
| Whole task while profiled                | 1,083–1,276 | 189–273      |        |

Same-node switches have almost no long task left (one of 51 ms in 20 controls).

Same-node content (ms). Target: at most 200 ms.

| D   | Base commit | After wave 0  | Delta | Result                                    |
| --- | ----------- | ------------- | ----- | ----------------------------------------- |
| 0   | 469         | 52 (42–64)    | -417  | met                                       |
| 20  | 526         | 104 (103–111) | -422  | met                                       |
| 40  | 475         | 114 (42–191)  | -361  | met                                       |
| 80  | 536         | 348 (343–351) | -188  | missed: one browser-node round trip (4·D) |

At D = 80 a thread window that is not already in memory costs one browser-node round trip, 320 ms,
so only a window kept in memory can meet the target at that delay.

Cross-node writable (ms). There is no target for this change; the next target is at most
12·D + 600:

| D   | Base commit | After wave 0        | Delta  | Next target | Result      |
| --- | ----------- | ------------------- | ------ | ----------- | ----------- |
| 0   | 1,504       | 340 (293–387)       | -1,164 | 600         | already met |
| 20  | 1,642       | 539 (511–593)       | -1,103 | 840         | already met |
| 40  | 1,766       | 794 (764–885)       | -972   | 1,080       | already met |
| 80  | 2,112       | 1,274 (1,258–1,329) | -838   | 1,560       | already met |

Cross-node content: 312, 522, 770 and 1,264 ms at D = 0, 20, 40 and 80. The fastest switches
(158–189 ms) show a thread that was already in memory at the first frame after the click.

Cold load, first content (ms, n = 10). Targets apply to a later cold-load change: at most 700 ms
at D = 0 and at most 3,000 ms at D = 40.

| D   | Base commit | After wave 0        | Delta | Later target | Result                                  |
| --- | ----------- | ------------------- | ----- | ------------ | --------------------------------------- |
| 0   | 788         | 572 (553–595)       | -216  | 700          | already met                             |
| 40  | 3,472       | 3,321 (3,263–3,443) | -151  | 3,000        | not yet: queueing behind the code burst |
| 80  | 6,176       | 6,010 (5,985–6,038) | -166  | reported     |                                         |

The serial chain is unchanged (5 browser-Hub and 3 browser-node round trips). Measured growth is
34.4 browser-Hub round trips from D = 0 to 40 and 34.0 from D = 0 to 80.

### Phase attribution

Node-switch marks of the cross-node switches, plus two server-side events: the Hub authenticating
the new stream and the node starting the shell subscription. Times are ms after the click, median
of 14. The intent mark is recorded 0.7 ms after the click.

| Phase                           | D = 0 | D = 20 | D = 40 | D = 80 |
| ------------------------------- | ----- | ------ | ------ | ------ |
| `requesting-ticket`             | 143   | 139    | 147    | 146    |
| `connecting`                    | 148   | 144    | 151    | 151    |
| `authenticating`                | 151   | 149    | 155    | 156    |
| Hub: stream authenticated       | 153   | 171    | 198    | 239    |
| Click long task ends            | 180   | 178    | 190    | 185    |
| `opening-channel`               | 201   | 200    | 239    | 322    |
| `online`                        | 224   | 363    | 540    | 855    |
| Node: shell subscription starts | 237   | 414    | 632    | 1,026  |
| `shell-accepted`                | 249   | 467    | 721    | 1,196  |
| `mutation-ready`                | 249   | 467    | 721    | 1,196  |
| Writable (composer editable)    | 340   | 539    | 794    | 1,274  |

On Hub session version 2 the transport passes through `requesting-ticket` without an HTTP ticket
request.

Where the 340 ms to writable go at D = 0:

1. 0–143 ms: click rendering before the relay connect starts. The route changes at once, but the
   connection is requested only 143 ms later, near the end of the click task.
2. 143–180 ms: the rest of the click task. The open request leaves during it; the Hub authenticates
   the stream at 153 ms.
3. Node channel open: the local Hub measured 39 ms (median of 8 opens) from forwarding the open to
   the node's accept at D = 0, and 113 ms at D = 40, of which 80 ms are the Hub-node round trip.
   This is the node preparing the channel, which includes reading its key custody files. It uses
   little main-thread CPU, so most of it is file I/O. It overlaps the end of the click task.
4. 180–201 ms: relay messages that arrived during the task are handled (long-task queueing).
5. 201–224 ms: the end-to-end handshake, until the channel is online.
6. 224–237 ms: the shell subscription reaches the node.
7. 237–249 ms: the shell is built, sent and accepted.
8. 249–340 ms: render after mutation readiness: thread content and the composer (about 85 ms).

The localhost gap, from the end of the click task to the node's shell subscription, is now 54 ms,
down from 314 ms, and no long task falls inside it. What remains is the part of the node channel
open that outlasts the click task, the handshake and the RPC setup. With delay each step adds its
round trips. `authenticating` to `online` covers the channel open and the handshake, two
browser-node round trips (8·D): 214, 385 and 699 ms at D = 20, 40 and 80, about 60 ms of local work
on top of the delay. `online` to the node's shell subscription, and from there to `shell-accepted`,
are one leg each (about 2·D plus 10 ms each). The target node spends about 66 ms of main-thread CPU
per cross-node switch at D = 0, spread over relay framing and end-to-end encryption, the Effect
runtime and SQLite read results.

### Cold load

Times in ms from navigation start, n = 10:

| D   | First content | Access check (session, directory) | Account socket opens | Shell snapshot received | Shell painted |
| --- | ------------- | --------------------------------- | -------------------- | ----------------------- | ------------- |
| 0   | 572           | 136 to 239                        | 267                  | 362                     | 550           |
| 40  | 3,321         | 311 to 2,455                      | 2,458                | 3,112                   | 3,292         |
| 80  | 6,010         | 462 to 4,589                      | 4,592                | 5,808                   | 5,984         |

Most of the D = 0 gain is the shorter work between the shell snapshot and its paint (188 ms, down
from 363 ms). The network chain and the route-code burst (150 requests) are unchanged. On 2 of 10
loads at D = 0 the browser fetched a relay ticket and used a ticketed stream instead of the Hub
session open, because the account socket had not finished its version negotiation yet (25–40 ms
slower).

### Cut list

Cold load, ranked by expected gain on this fixture:

1. Fewer module requests on a cold thread route: group the static module closure of the thread
   route and the hosted root shell into a few chunks instead of ~150 files requested in one burst.
   About -1.7 s at D = 40, -3.4 s at D = 80 and -90 ms at D = 0 here; much less behind HTTP/2.
2. Send the access check before any code prefetch in the boot gate, so the answer never waits
   behind chunk downloads: about -100 ms at D = 0 and up to -600 ms at D = 40 on its own.
3. Open the account socket next to the access check for a browser that was signed in at its last
   check, and bind it to the answer's identity before any stream opens: two browser-Hub round trips
   (-160 ms at D = 40).
4. Start the access check while the HTML parses, with fetch preloads that the boot gate's identical
   requests consume: about -120 ms at D = 0 and -220 ms at D = 40.
5. Start the access check from the entry module instead of the root route: about -18 ms
   (superseded by 4).
6. Skip the second node-directory request of every cold load when the directory has not changed
   (make it conditional; never drop it).

Outside the boot files:

7. Wait for the account socket's version negotiation instead of falling back to a relay ticket
   (2 of 10 loads at D = 0; one more round trip at D > 0 when it happens).
8. Render the routed thread before the full inbox on boot (the sidebar commit, about 95 ms, and the
   shell paint, about 80 ms, run before the thread paints).
9. Skip thread-cache probes for nodes that have no cache (six requests per cold load that answer
   404 with the cache off).
10. Request the routed thread's window together with the shell subscription (sent about 170 ms
    later today at D = 0; about -25 ms).

Switch path:

- Start the relay connect at the switch intent instead of after the click's render work: about
  -145 ms for every cold cross-node switch, at every delay.
- About 85 ms of render pass between mutation readiness and an editable composer.

Every cut keeps the hosted rules: the session and directory are revalidated before any authority,
a fresh relay attempt and a current shell snapshot come before mutations, and the service worker
caches the static shell only.

## After wave 1

## After wave 2

## After wave 3 (final)

## Node

## Desktop

## Mobile

## RAM/CPU scorecard

Local fixture, the same machine and session as the switch measurements. Node rows are per node
process (two nodes; for the base commit, two repetitions). "Wake-ups" are context switches of the
node process, a proxy for timer wake-ups.

| Metric                                                                   | Base commit           | After wave 0                             | Delta                      | Target                                |
| ------------------------------------------------------------------------ | --------------------- | ---------------------------------------- | -------------------------- | ------------------------------------- |
| Web JS heap after 10 cross-node switches (used, after GC; 2 runs)        | 89.1 MiB              | 81.0 MiB                                 | -8.1 MiB                   |                                       |
| Web JS heap after visiting both nodes, before the switches               | 61.7 MiB              | 70.6 MiB                                 | +8.9 MiB                   |                                       |
| Node RSS, idle, no client                                                | 269–277 MiB           | 275–279 MiB                              | about +4 MiB               |                                       |
| Node RSS while serving a switching browser (median / max)                | 331–347 / 352–377 MiB | 357–366 / 359–369 MiB                    | about +15 / -5 MiB         |                                       |
| RSS of the node an idle browser stays subscribed to, after serving       | 390–395 MiB           | 369 MiB                                  | about -23 MiB              |                                       |
| Node wake-ups per second, idle, no client                                | 4.5–4.7               | 1.8–1.9                                  | -2.8                       |                                       |
| Wake-ups per idle subscription per second (10 subscriptions open)        | 10.0                  | 0.26                                     | -9.7                       | no recurring timer wake-ups: met      |
| `bun dev` peak RSS (process tree, 150 s, no browser)                     | 2,646 MiB             | 1,024 MiB                                | -1,622 MiB                 | -1.4 GB: met                          |
| Codex status probe process starts per node (boot and a 5-minute session) | 1                     | 1                                        | 0                          | not exercised (see below)             |
| `ps` spawns per minute with one idle terminal                            | 12                    | 12 in the first idle minute, then 2      | -10 after the first minute | at most 2: met after the first minute |
| Persisted rows for a 60-delta subagent message (the change's tests)      | 60 (one per delta)    | 2 while streaming, 3 with the completion | -57                        |                                       |
| Persisted rows for 30 usage-only progress ticks (the change's tests)     | 30 (one per tick)     | 1, plus 1 trailing write                 | -28                        |                                       |

- The residual 0.26 wake-ups per idle subscription are consistent with keepalive traffic on the
  open channel, not timers.
- After wave 0 the idle terminal's activity check backs off to every 30 s after a minute without
  activity; before it ran every 5 s for as long as the terminal was open.
- The Codex probe row is not a measurement of the change: both revisions start one status probe
  process per node at boot, and no stale re-probe happened during the 5-minute session, so the path
  that now reuses the long-lived reader was not exercised.
- The web heap after visiting both nodes is higher after wave 0, while the heap after the switches
  is lower: switches retain less.

## Production (manual)
