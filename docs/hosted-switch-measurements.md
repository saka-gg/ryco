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

Revision: the wave-0 tip plus the second set of changes. On the switch path: hosted capability is
resolved per environment, and the hosted lifecycle controller gains a retained mode that the web
app does not enable yet (it keeps one hosted connection, so every cross-node switch below is still a
cold open); relay end-to-end encryption runs per channel; the node builds its shell when a relay
channel opens and serves that build again only while it is exactly current; and the node serves
the thread windows a view waits on before the windows that retained subscriptions reload. Outside
it: fewer serial steps in the desktop's native relay connect, bounded thread-body retention in the
client store, and a single inline script in the hosted index.

Setup, as under "Baseline (base commit)" except:

- The wave-0 tip is measured again in the same session, interleaved: blocks in the order wave-0
  tip, wave-1 tip, three times. Each revision runs against the Hub revision it was developed with,
  with its own bundle, Hub data and node homes.
- A third node with 30 projects and 2,000 threads (60% archived, 777 listed) serves the
  2,000-thread rows. Every node home is a copy of the same generated fixture in both revisions.
- Every node records every span (no minimum span duration), in both revisions alike, so a shell
  build of 2 ms appears in the node trace.
- Per block and delay: one `hosted-switch` run with 8 cross-node switches and 3 same-node controls,
  the second of each CPU-profiled and left out of the medians, and five cold loads at D = 0 and 40.
  Medians pool the three blocks: 21 cross-node switches, 6 same-node controls and 15 cold loads per
  delay and revision. No switch or load timed out or failed.
- The wave-0 tip's hosted index has two inline scripts and the Hub serves exactly one, so that
  bundle is served with the two merged, which is what the wave-1 change does in the source.
- 1-minute load average 5.4–8.6 during the blocks.

### Against the targets

Cold cross-node writable (ms, n = 21). Target: at most 12·D + 600.

| D   | Base commit | After wave 0        | After wave 1        | Delta | Target | Result |
| --- | ----------- | ------------------- | ------------------- | ----- | ------ | ------ |
| 0   | 1,504       | 324 (286–369)       | 316 (283–358)       | -8    | 600    | met    |
| 20  | 1,642       | 537 (502–719)       | 519 (502–562)       | -18   | 840    | met    |
| 40  | 1,766       | 774 (741–851)       | 777 (741–819)       | +3    | 1,080  | met    |
| 80  | 2,112       | 1,254 (1,227–1,302) | 1,252 (1,231–1,280) | -2    | 1,560  | met    |

"After wave 0" is the wave-0 tip measured in this session; the earlier session measured 340, 539,
794 and 1,274 ms. Block medians of one revision and delay differ by up to 59 ms, so none of these
deltas is a change: wave 1 leaves the cold switch between the two small nodes where wave 0 put it,
which already met the target. On these nodes its switch-path changes take a 2–3 ms shell build off
the critical path. Wave 1 shows on the 2,000-thread node and after relay drops (see "Node"); the
retained mode it adds is not enabled in the web app yet.

Other switch metrics, ms after the click, median (n = 21):

| D   | Click long task, after wave 0 → 1 | First frame, after wave 0 → 1 | Content, after wave 0 → 1 |
| --- | --------------------------------- | ----------------------------- | ------------------------- |
| 0   | 171 → 173                         | 173 → 175                     | 302 → 296                 |
| 20  | 174 → 172                         | 176 → 174                     | 522 → 514                 |
| 40  | 169 → 170                         | 171 → 172                     | 758 → 759                 |
| 80  | 167 → 170                         | 169 → 173                     | 1,242 → 1,241             |

- After wave 1 the click long task takes 147–203 ms and stays within its target (at most 250 ms)
  at every delay. In the profiled switches (12 per revision, all delays) the task takes 198–212 ms
  while profiled (198–222 after wave 0), with 2.1–3.7 ms of inbox row code (target at most 30 ms),
  14–17 ms of all inbox sidebar code, 53–60 ms of React DOM and 40–48 ms of Base UI, the same as
  after wave 0.
- Same-node controls, both revisions: a window that is already in memory shows in 40–64 ms at
  every delay, and one that is not costs one browser-node round trip: 73–130, 179–194 and
  342–345 ms at D = 20, 40 and 80. The same-node target (at most 200 ms) is met by a window in
  memory and missed at D = 80 by one that is not, as after wave 0.

### Phase attribution

Cross-node switches after wave 1, ms after the click, median of 21. The node rows come from the
target node's trace; the channel open, shell build and first-response spans are new in wave 1.
After wave 0, the client marks and the node's shell subscription are within 10 ms of these values
at every delay.

| Phase                                 | D = 0   | D = 20  | D = 40  | D = 80  |
| ------------------------------------- | ------- | ------- | ------- | ------- |
| `requesting-ticket`                   | 135     | 136     | 137     | 136     |
| `authenticating`                      | 146     | 143     | 143     | 144     |
| Hub: stream authenticated             | 149     | 165     | 187     | 226     |
| Node: channel open starts             | 150     | 185     | 227     | 308     |
| Click long task ends                  | 173     | 172     | 170     | 170     |
| Node: channel accepted                | 184     | 218     | 263     | 339     |
| Node: shell build, start to end       | 187–190 | 220–221 | 264–267 | 340–341 |
| `opening-channel`                     | 192     | 188     | 227     | 307     |
| `online`                              | 215     | 351     | 517     | 833     |
| Node: shell subscription arrives      | 226     | 402     | 607     | 1,006   |
| Node: first shell message sent        | 228     | 404     | 610     | 1,007   |
| Node: first thread window message     | 235     | 408     | 613     | 1,011   |
| `shell-accepted` and `mutation-ready` | 236     | 449     | 694     | 1,172   |
| Writable (composer editable)          | 316     | 519     | 777     | 1,252   |

- Every cross-node switch after wave 1 shows exactly one shell build on the target node (84 of 84
  over the four delays). It starts 1–3 ms after the channel is accepted, takes 2–3 ms, and is done
  37 ms (D = 0) to 665 ms (D = 80) before the shell subscription arrives. The subscription is
  served that build without a second one: its first message leaves 2.1–2.5 ms after the request.
- The node's channel open (from the open the Hub forwards to the accepted channel) takes 32–34 ms at
  every delay (29–59 ms). The node's key custody reads are part of it and unchanged: the change that
  memoizes them was not taken.
- At D = 0 the 316 ms to writable are 135 ms of click rendering before the relay connect starts,
  11 ms until the stream authenticates, 69 ms from `authenticating` to `online` (channel open and
  handshake), 22 ms from `online` to the accepted shell and 80 ms of rendering after mutation
  readiness.
- From D = 0 to 80, writable grows by 936 ms, 11.7·D: `authenticating` to `online` by 7.8·D (two
  browser-node round trips), `online` to the node's shell subscription by 2.0·D and the subscription
  to `shell-accepted` by 2.0·D. The node answers each leg within 2–5 ms.

### 2,000-thread node

Cross-node switches between the 120-thread node and the 2,000-thread node, in interleaved blocks
(wave-0 tip, wave-1 tip, twice; no CPU profiles), 8 switches to each node per revision and delay.
ms after the click, median:

| Target node   | D   | Click long task, after wave 0 → 1 | `online` to `shell-accepted`, after wave 0 → 1 | Writable, after wave 0 → 1 |
| ------------- | --- | --------------------------------- | ---------------------------------------------- | -------------------------- |
| 2,000 threads | 0   | 567 → 561                         | 124 (112–137) → 98 (95–104)                    | 1,272 → 1,283              |
| 2,000 threads | 40  | 579 → 573                         | 421 (416–440) → 389 (383–394)                  | 1,834 → 1,794              |
| 120 threads   | 0   | 885 → 900                         | 31 → 29                                        | 1,138 → 1,129              |
| 120 threads   | 40  | 893 → 905                         | 187 → 185                                      | 1,533 → 1,544              |

- On the 2,000-thread node the build at channel open takes 26–29 ms (median) and is done 76 ms
  (D = 0) to 331 ms (D = 40) before the shell subscription arrives. The first shell message still
  leaves 18–20 ms after the request, the time to encode and encrypt the large shell. `online` to
  `shell-accepted` is 26–32 ms shorter than after wave 0, the build that no longer runs after the
  request.
- Writable does not follow, because the click long task (561–905 ms with 2,000 threads in the
  inbox, longer when leaving the large node than when entering it) and 530–560 ms of rendering
  after mutation readiness on the large node dominate it. Wave 1 changes neither. The cold target
  is defined on the two small nodes; on this one the click long task and that rendering alone
  exceed it.

### Cold load

First content (ms, n = 15): 558 (546–637) after wave 0 and 567 (548–593) after wave 1 at D = 0;
3,251 (3,233–3,409) and 3,256 (3,226–3,266) at D = 40. Wave 1 has no cold-load change; the targets
for a later change (700 ms at D = 0 and 3,000 ms at D = 40) stand as after wave 0.

### Node

| Row                                                         | After wave 0                | After wave 1                    | Target       | Result     |
| ----------------------------------------------------------- | --------------------------- | ------------------------------- | ------------ | ---------- |
| Key custody reads in a web channel open (advertisement p50) | read on every open          | unchanged                       | under 2 ms   | not landed |
| Shell builds for a second open within 2 s, no new event     | one (no memo)               | 0 (3 of 3)                      | none         | met        |
| Shell builds per cold cross-node switch, 120 or 80 threads  | one, after the subscription | one, at channel open (84 of 84) |              |            |
| Routed thread after a relay drop, 10 retained threads       | not writable again (3 of 3) | writable again (9 of 9)         | served first | met        |

- Key custody: the change that memoizes the node's key custody reads was not taken, so a web channel
  open still reads them; the whole channel open is 32–34 ms (see "Phase attribution").
- Shell memo: three browsers open the 2,000-thread node 0, 0.7 and 4 s apart, in three rounds. The
  first channel's build at channel open serves its own subscription; the second channel, 0.7 s
  later, builds nothing; the third, 4 s later and so past the memo's 2 s, builds again. Every round
  shows exactly two builds for three subscriptions, each 46–65 ms with three cold loads under way.
  Before wave 1 there is no memo (only concurrent requests share a build) and no build span, so the
  wave-0 cells of the two shell rows describe the code, not a trace.
- Relay drops: the browser holds 10 threads of the 120-thread node, opened one after another, and
  the routed thread; restarting the delay proxy then drops every relay connection at once,
  including the nodes'. Three runs per revision, each with up to three drops 12–14 s apart.
  - After wave 0 the page did not recover in any run: from the read-only banner (348–375 ms after
    the drop) its main thread stayed busy for the whole 45 s observed, no new client stream reached
    the Hub and the session never became writable again.
  - After wave 1 every drop cost one client stream, one channel open and one shell subscription on
    the node, and the page stayed responsive (0.10–0.23 s of main-thread tasks during a recovery).
    It was writable again 1.05–1.30 s after the first drop of each run. Later drops took 1.9–12.2 s:
    the nodes came back later each time (after 1.7–4.5 s) and the client's next retry then waited
    longer still.
  - The replacement channel asked for 22 thread windows. In every drop, 2–4 of them were served out
    of arrival order, 1.9–13 ms after they arrived and ahead of 3–17 windows that had arrived
    before them: the windows a view waits on, which the node starts at once. The others took turns,
    and the last first message left 58–96 ms after the first request. The trace does not name
    threads, so the windows a view waits on are recognized by that order, not by their ids.

### Desktop

Not measured on a native client. The local fixture cannot sign in a native client, and a run
against the production Hub needs the owner's interactive sign-in and enrolls the desktop as a device
on a real account, so both rows are manual production checks. The evidence here is the desktop unit
tests: 94 pass in the relay, handshake, prekey, security helper and background signal suites.

- Cold remote connect, before and after the connect trims. Target: 50–130 ms faster, and at most one
  public-key read from the security helper per process. Not measured. The tests show the relay
  socket upgrade starting before the ticket resolves and the auth frame going out on that socket
  (also over a real socket); an account-trusted target needing no ticket request and upgrading
  beside the E2EE preparation; the client public keys read from the helper once per process, until
  a key reset; and the helper kept up while a relay transport holds it.
- Relay upgrades on Cmd-Tab or window blur. Target: 0, with warm connections kept. Not measured
  live. Since wave 0 the tests show that focus loss alone never backgrounds the workspace, through
  30 minutes of blur and focus events; minimize, hide and lock background it only after a 3-minute
  grace period, and suspend at once.

### Memory

One browser opens 100 listed threads of the 2,000-thread node in a row (in-app navigation, each
until its messages show), then stays idle for 7 minutes. The JS heap is measured after a garbage
collection. Thread bodies are counted in a heap snapshot: 88 of the 100 threads have more than one
turn, and only a loaded body holds the id of such a thread's first assistant message (the shell
names the latest ones). Two runs per revision. As generated, every fixture session is `ready`, the
state a node leaves after a completed turn, and the retention counts a `ready` session as busy, so
the wave-1 tip also ran with every session set to `stopped`.

| Metric                                                          | After wave 0              | After wave 1              | Delta        | Target                     | Result                                     |
| --------------------------------------------------------------- | ------------------------- | ------------------------- | ------------ | -------------------------- | ------------------------------------------ |
| Web JS heap after 1 / 32 / 64 / 100 threads (MiB, median)       | 34.1 / 62.5 / 81.2 / 98.9 | 34.0 / 62.9 / 81.7 / 99.1 | about 0      |                            |                                            |
| Web JS heap after 7 minutes idle (MiB)                          | 98.7–98.9                 | 98.3–100.1                | about 0      |                            |                                            |
| Thread bodies held (of 88 countable), after opening 100 threads | 88                        | 88                        | 0            |                            |                                            |
| The same after 7 minutes idle, sessions `ready`                 | 88                        | 88                        | 0            | at most 64, plus protected | met only because every thread is protected |
| The same after 7 minutes idle, sessions `stopped`               |                           | 88                        |              | at most 64, plus protected | missed                                     |
| Node RSS of the 120-thread node, idle                           | 270 MiB                   | 267 MiB                   | -3 MiB       |                            |                                            |
| The same with 3 open channels (median / max)                    | 304 / 305 MiB             | 294 / 304 MiB             | -10 / -1 MiB |                            |                                            |

- No body was evicted in any run. A heap snapshot after the idle period (wave-1 tip, sessions
  `stopped`) shows the store's message index holding 174 threads with 1,466 message ids: the 100
  opened and 74 the probe never opened. A memo keyed by per-thread store records holds the composed
  content of the same 174 threads. With sessions stopped, the busy-thread rules keep only the 22 of
  the 100 threads with an actionable proposed plan, so they do not explain the miss; its cause is
  not established by this measurement.
- Node RSS: one 30 s idle sample and one 60 s sample with three browser contexts holding a channel
  each, per revision. Single samples, so the differences are not conclusive.

### Relay round trips

The in-process multi-node harness (the real browser and node relay stacks with the NX handshake,
over a Hub that only forwards frames, 10 ms of virtual delay per hop) counts the same at both tips:

| Count                                                                                 | After wave 0 | After wave 1 |
| ------------------------------------------------------------------------------------- | ------------ | ------------ |
| Relay round trips from the open to the accepted shell (`COLD_OPEN_RELAY_ROUND_TRIPS`) | 3            | 3            |
| The same with a shell of five messages                                                | 7            | 7            |
| Hub frames and bytes, first cold open                                                 | 28, 11,733 B | 28, 11,733 B |
| Hub frames and bytes, opening a second node                                           | 47, 15,285 B | 47, 15,285 B |
| Replacement channels per relay drop                                                   | 1            | 1            |
| Shell builds when a node is reopened within 2 s, no new event                         | not covered  | 0            |

A relay drop costs one open, one channel and 3 round trips, with no new account socket and no ticket
request, at both tips. On the fixture, every relay drop after wave 1 cost one client stream, one
channel open and one shell subscription on the node; after wave 0 the page did not reconnect at all
(see "Node").

## After wave 2

Revision: the wave-1 tip plus the third set of changes. On the switch path: hosted web runs one
connection per environment on the shared demand executor, still with one allowed connection (so
every cross-node switch below is still a cold open); queued sends drain per environment session;
the chat stays quiet while a node connects and queues sends until the node is ready; the hosted
shell stays mounted when a switch opens a node route that is not a cached thread; capability checks
name the environment they act on. Outside it: mobile runs on the shared session registry and demand
executor, the mobile and desktop apps keep recent conversation text on the device (on by default,
behind a device setting), and server and clients share the activity and revert helpers.

Setup, as under "After wave 1" except:

- The wave-1 tip is measured again in the same session, interleaved: blocks in the order wave-1
  tip, wave-2 tip, three times. Both revisions run against the same Hub revision, each with its own
  bundle, Hub data and node homes (copies of the same generated homes).
- The two nodes with 120 and 80 threads only, at D = 0 and 40. Nodes record their default spans.
- The probes send messages, so the nodes run with every provider runtime disabled and without
  provider credentials; a turn start then fails on the node before any provider would run.
- Per block and delay: one `hosted-switch --send` run with 8 cross-node switches and 3 same-node
  controls (no CPU profiles), which types and sends a message once each switch is writable; then
  one run of a send-during-switch probe with 8 cross-node switches, which clicks the composer as
  soon as the URL shows the target thread, types a message and presses Enter (and presses it again
  once the thread is writable if the first press was refused); then 4 switches from a writable
  thread onto the other node's projects route, with one of its projects open, each observed for
  5 s. Medians pool the three blocks: 24 cross-node switches, 9 same-node controls, 24 sends during
  a switch and 12 projects-route switches per delay and revision. No switch, send or navigation
  timed out or failed, and the pages logged no errors.
- "Writable" follows the dispatch capability in both revisions: the wave-2 build marks it on the
  chat (`data-mutation-ready`); the wave-1 build has no marker and is measured by the absence of
  the read-only banner and an editable composer.
- 1-minute load average 4.9–11.9; the third wave-2 block at D = 0 ran at 11–12, the session's
  highest.

### Against the targets

Send accepted: ms from pressing Enter until the composer clears or a queued row shows, median
(min–max). Target: at most 100.

| Send                                    | D   | After wave 1          | After wave 2            | Result                               |
| --------------------------------------- | --- | --------------------- | ----------------------- | ------------------------------------ |
| During a cross-node switch, queued      | 0   | refused (5 of 5)      | 7.5 (5–17), n = 20      | met                                  |
| During a cross-node switch, queued      | 40  | refused (24 of 24)    | 7 (5–21), n = 24        | met                                  |
| To a writable thread (`--send`), direct | 0   | 116 (26–141), n = 24  | 118.5 (111–141), n = 24 | missed: waits for the list to scroll |
| To a writable thread (`--send`), direct | 40  | 116 (113–128), n = 24 | 117 (114–125), n = 24   | missed: waits for the list to scroll |

- During a switch, wave 2 queues the send at once: the queued row shows 5–21 ms after Enter and
  184–303 ms after the switch's click, which includes the click's own task (the first frame comes
  at 144.5–157 ms, median) and the probe finding and typing into the composer. After wave 1 the
  first press is refused while the node connects: the text stays in the composer, the send button
  shows its busy spinner, and the message only goes out when it is sent again after the thread is
  writable. At D = 0, 4 of the 24 wave-2 sends (19 of 24 after wave 1) came after the switch was
  already writable and took the direct path.
- A queued send never left before its thread was writable (0 of 44). It shows as a sent message
  113.5 (98–147) ms after writable at D = 0 and 115 (104–126) ms at D = 40, through the same direct
  send path as below; its queued row clears when the node acknowledges the turn, 130 and 285.5 ms
  after writable (one more browser-node round trip, 4·D, at D = 40).
- A send to a thread that is already writable takes the direct path in both revisions. It waits
  for the message list to finish scrolling to its end before it shows the message and clears the
  composer, which takes 110–141 ms; when the list does not move it takes 26–27 ms (8 of 132 such
  sends, 7 of them in same-node controls). The miss is this wait, not the network: the times do
  not grow with D.

The quiet chat during a switch, counted over both probes (48 cross-node switches per delay and
revision):

| Seen before the thread is writable                        | D   | After wave 1                   | After wave 2                   |
| --------------------------------------------------------- | --- | ------------------------------ | ------------------------------ |
| "Read-only hosted session" warning                        | 0   | 48 of 48, from the first frame | 0 of 48                        |
| "Read-only hosted session" warning                        | 40  | 48 of 48, from the first frame | 0 of 48                        |
| Busy send button (send-during-switch probe, 24 per delay) | 0   | 24 of 24                       | 0 of 24                        |
| Busy send button (send-during-switch probe, 24 per delay) | 40  | 24 of 24                       | 0 of 24                        |
| "Syncing with <node>…" note (send-during-switch probe)    | 0   | not in this build              | 24 of 24, from the first frame |
| "Syncing with <node>…" note (send-during-switch probe)    | 40  | not in this build              | 24 of 24, from the first frame |

No same-node control showed the warning in either revision.

Cold cross-node switch, ms after the click, median (min–max), n = 24 (the `hosted-switch` runs).
Target: writable at most 12·D + 600.

| D   | Content, after wave 1 → 2 | Writable, after wave 1 | Writable, after wave 2 | Delta | Target | Result |
| --- | ------------------------- | ---------------------- | ---------------------- | ----- | ------ | ------ |
| 0   | 289 → 286.5               | 298.5 (278–328)        | 306 (267–428)          | +7.5  | 600    | met    |
| 40  | 760.5 → 750               | 762.5 (747–836)        | 760.5 (741–802)        | -2    | 1,080  | met    |

- Block medians of one revision and delay differ by up to 110 ms at D = 0 (the third wave-2 block,
  at the session's highest load) and 15 ms at D = 40, so neither delta is a change: wave 2 leaves
  the cold open where wave 1 put it. The earlier session measured the wave-1 tip at 316 and 777 ms.
- The click's long task is shorter after wave 2: the first frame after the click comes at 157 ms
  (D = 0) and 144.5 ms (D = 40), against 170.5 and 178 ms after wave 1. Five of the six wave-2
  block medians are 144.5–149.5 ms, against 164.5–183.5 ms for all six wave-1 blocks; the outlier
  is the loaded block (205 ms). These switches were not CPU-profiled, so the cause is not
  attributed. The click task stays within its target (at most 250 ms) in both revisions.
- Same-node content: 58 → 39 ms at D = 0 and 178 → 178 ms at D = 40, where a window that is not in
  memory costs one browser-node round trip, as in the earlier rounds.

### Hosted shell during a switch

From a writable thread, an in-app navigation to the other node's projects route with one of its
projects open. ms after the navigation, median (min–max), n = 12:

| What the page shows                         | D   | After wave 1                    | After wave 2                   | Delta  |
| ------------------------------------------- | --- | ------------------------------- | ------------------------------ | ------ |
| First frame after the navigation            | 0   | 15 (12–28), the surface         | 153.5 (113–177)                | +138.5 |
| First frame after the navigation            | 40  | 16 (12–25), the surface         | 142 (104–197)                  | +126   |
| Full-page "Connecting to <node>" surface    | 0   | 12 of 12, until 169.5 (155–181) | 0 of 12                        |        |
| Full-page "Connecting to <node>" surface    | 40  | 12 of 12, until 652 (642–675)   | 0 of 12                        |        |
| Sidebar unmounted                           | 0   | 12 of 12                        | 0 of 12                        |        |
| Sidebar unmounted                           | 40  | 12 of 12                        | 0 of 12                        |        |
| Projects page painted, with the sidebar     | 0   | 169.5 (155–181)                 | 161.5 (138–177)                | -8     |
| Projects page painted, with the sidebar     | 40  | 652 (642–675)                   | 168 (128–217)                  | -484   |
| Target node shown as connecting on the page | 0   | not shown                       | 161.5 (138–177), 12 of 12      |        |
| Target node shown as connecting on the page | 40  | not shown                       | 168 (128–217), 12 of 12        |        |
| Target node usable (session ready)          | 0   | 169.5 (155–181), surface ends   | 282 (266–292), shown as online | +112.5 |
| Target node usable (session ready)          | 40  | 652 (642–675), surface ends     | 742 (713–785), shown as online | +90    |

- After wave 1 the whole app gives way to "Connecting to <node>" from the first frame (12–28 ms)
  until the session is established (its shell snapshot accepted), and the shell then mounts
  again. The projects page paints in the frame the surface ends, so that time includes the
  shell's mount render, and the session was ready at or before it.
- After wave 2 the shell and the sidebar stay mounted throughout. The first frame after the
  navigation comes at 142–153.5 ms (median), after the navigation's own render; the projects page
  paints at 161.5 and 168 ms and shows the target node's device as connecting from its first
  frame. That section-level state turns to online when the node's capability is ready, which
  needs the same accepted snapshot.
- Wave 2 paints the projects page about as soon at D = 0 and 484 ms sooner at D = 40, but on this
  route the node is usable about 90–110 ms later: +112.5 ms at D = 0 and +90 ms at D = 40, a
  regression. The ranges of the two revisions do not overlap at either delay (12 runs each).
- Counted from the first frame after the navigation, the node is ready 134.5 (108–159) ms later at
  D = 0 and 600 (587–623) ms at D = 40 after wave 2, against 154 (140–167) and 637 (621–659) ms
  after wave 1, so the time is lost before that frame. The likely cause is the navigation's render
  of the mounted shell, a main-thread task of about 140–150 ms that runs before the connection
  makes progress, where wave 1 paints its light surface in 15–16 ms. These navigations were not
  CPU-profiled, so the cause is not confirmed.
- A thread route pays a click task of a similar size in both revisions (see the cold cross-node
  switch above). That is why the readiness here after wave 2 is close to the cross-node writable
  times (282 against 306 ms at D = 0, 742 against 760.5 ms at D = 40), while wave 1 was ready
  sooner on this route than on a thread route.

### Retained mode

Hosted web still allows one connection in production, so the fixture measures single mode only.
The evidence for the retained mode is the integration test of the hosted web retained environment
sessions, which forces it through the runtime test seam with the real controller, registry,
executor and coordinator over a fake relay. All 10 cases pass (with the connection coordinator's
24):

- One allowed connection: switching A → B → A never holds more than one live hosted connection and
  never returns to the directory for the swap.
- Three allowed connections: with three nodes held by open views, a routed fourth node gets no
  connection and waits in the queue; selecting it creates no connection or transport.
- Three allowed connections: switching back to a live session adopts it, with one transport and
  one shell subscription for that node in total and the session ready at once.
- Freeze and resume with two retained records: both are acquired again after revalidation, the
  routed one at the resume and the other at least 750 ms later, and neither keeps authority from
  its old session.
- Also: commands stay refused on an environment that is still synchronizing while another is
  ready; a route that follows an acquire within 100 ms joins it (one attempt); a leased warm
  record reconnects after a relay drop while the directory is shown, with no node selected; a
  warm record without a lease is released when its relay drops while a leased one reconnects; a
  terminally failed record is not retried until its directory entry changes; and the routed
  environment is kept through six hidden minutes of throttled ticks.

The full-app test of the quiet chat passes too (10 cases), including a send queued less than
100 ms after the send click while the node connects, and a draft's first send queued the same way.

### Mobile

Not measured on a device. The local fixture cannot sign in a native client, and a run against the
production Hub needs the owner's interactive sign-in and enrolls a device on a real account, so the
device rows are manual production checks. The evidence here is the mobile unit tests: 148 pass in
the node lifecycle, connection coordinator, primary connection, retained wake, snapshot
persistence, snapshot codec, snapshot database and preferences suites.

| Row                                               | Target                                  | Evidence                                                          |
| ------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------- |
| Re-selecting a warm node                          | 0 network calls, mutation-ready at once | met in the test; time to writable on a device not measured        |
| Opening a node cold                               |                                         | not measured                                                      |
| Cold app start to the first cached thread content |                                         | not measured; the tests show cached messages before any live data |
| Native cipher decrypt time per MiB                |                                         | not applicable: the native cipher change was not taken            |

- Warm re-select: with two nodes established, selecting B and then A leaves the session online,
  ready and current synchronously after each selection, with no lifecycle call, no Hub session or
  directory request, both connections kept and none disposed.
- Recent conversation text: with the setting at its default (on), a cold start shows the last
  messages of a cached thread before any live data; a live window replaces them; turning the
  setting off, signing out or a revoked node removes the stored text.

### Desktop

Not measured on a native client, for the same reason as mobile. The desktop content cache and the
renderer that captures and hydrates it pass their tests: 50 in the cache and workspace IPC suites
and 28 in the renderer's workspace suite. They show the cache kept across restarts, encrypted, in
a private file, and served only to the account and environment it was saved for; the renderer
paints the cached conversations of the threads the cached shell lists, lets live data win over a
late answer, and keeps nothing while the setting is off. Cold app start to the first cached thread
content is a manual production check.

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
