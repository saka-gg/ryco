# Hosted switch measurements

A ledger of local-fixture measurements for switching between nodes in the hosted web app and for
loading a thread cold. Each section below is filled in by the measurement run that belongs to it;
numbers are generic and aggregate (medians with min-max over at least seven iterations), with the
fixture shape stated next to them. Hostnames, ids, logs and raw traces are not recorded here.

## Summary

The base commit against the final tip, on the local fixture: ms after the click, median, unless
stated. The fixture grew from two nodes to four over the measurements and the switch probe changed
once (see "After waves 4 and 5 (final)"), so each section states its own setup.

| Metric                                                      | D           | Base commit                   | Final                                             |
| ----------------------------------------------------------- | ----------- | ----------------------------- | ------------------------------------------------- |
| Cross-node switch, writable                                 | 0 / 40      | 1,504 / 1,766, every one cold | 149 / 185 to a warm node, 355 / 838 to a cold one |
| Warm switch to a thread not shown yet, writable             | 0 / 40 / 80 | (every switch cold)           | 149 / 185 / 346                                   |
| Switch back to a thread already opened, writable            | 0 / 40      | (every switch cold)           | 144 / 139.5                                       |
| Cold switch to a node the tab is not connected to, writable | 0 / 40      | 1,504 / 1,766                 | 355 / 838                                         |
| Click long task of a cross-node switch                      | 0           | 1,019                         | 121.5 warm, 197 cold                              |
| Same-node switch, content                                   | 0           | 469                           | 38                                                |
| Cold load, first content (ms from navigation start)         | 0 / 40      | 788 / 3,472                   | 508 / 3,034                                       |
| Web JS heap after opening 100 threads and 7 minutes idle    |             | 96–98 MiB (after wave 2)      | 47.7–47.8 MiB                                     |
| Thread bodies kept after that                               |             | every body                    | 64                                                |

- At the base commit a tab held one node connection, so every cross-node switch opened a new one.
  The final tip keeps up to three nodes connected per tab and restores them after a background,
  a page freeze, going offline or a reload of a remembered browser; a switch to one of them opens
  no stream and needs no shell, and a switch to any other node is writable within its
  `12·D + 600` ms budget at every delay measured.
- Met at the final tip: the warm switch targets up to D = 40, the cold switch budget at every delay,
  same-node content up to D = 40, a send accepted within 11–15 ms, the D = 0 cold load and the
  thread-body budget. Missed: a warm switch to a thread not shown yet at D = 80 (one browser-node
  round trip, 320 ms, is longer than the target), same-node content at D = 80 for a window not in
  memory, the D = 40 cold load by 1% (3,034 against 3,000 ms) and its round-trip count (31.6 against
  28.6), both limited by queueing on six connections over plain HTTP/1.1.
- Native Desktop and mobile rows remain manual production checks.

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

## After wave 3

Revision: the wave-2 tip plus the fourth set of changes. On the switch path: hosted web keeps up to
three nodes connected per tab (a warm set), so a switch to one of them adopts its live session
instead of opening a new stream; pressing a thread row of another node starts its connection before
the click; every hosted capability check names the environment it acts on; thread bodies the store
no longer needs are released, so retention frees memory; the hosted cold load sends its access
check before any code prefetch, opens the account socket beside it and loads the thread route in
fewer chunks; and the chat no longer re-measures its layout on every thread switch. The node code is
unchanged.

Setup, as under "After wave 2" except:

- Two arms, interleaved in one session: "before" is the wave-2 tip (one hosted connection per tab)
  and "final" the wave-3 tip (warm set of three). Neither the server code nor the probes differ
  between them, so one Hub data directory, one owner and one set of nodes serve both; each block
  restarts the Hub with that arm's bundle.
- Four nodes with 120, 80, 100 and 100 threads (3–4 projects each, 20% archived, 4 turns), and a
  fifth with 2,000 threads (30 projects, 60% archived) that runs only for the memory rows. Every
  provider runtime is disabled, Hub session version 2, Hub thread cache off, every node span
  recorded.
- Blocks: before, final, three times at D = 0 and 40; one block per arm at D = 20 and 80. Per
  block and delay, with nodes 1–3 online: one `hosted-switch --send` run (8 cross-node switches and
  3 same-node controls; in the final arm every cross-node switch goes to a warm node); at D = 0
  and 40, 3 rounds of switching back to threads already opened on the three nodes; at D = 0, 40
  and 80, 10 fresh and 10 visited cold loads. Then with node 4 online, at every delay: 10 cold
  cross-node switches without sends and a send-during-switch run with 8 switches. One more warm run
  per arm at D = 0 CPU-profiles one cross-node and one same-node switch.
- Cold switches. The harness rotates through the nodes in the inbox's order, which here never
  reached the fourth node (the order moves the node in view, and sending moves it further), so in
  the final arm it kept returning to warm nodes. The final arm's cold switches therefore use the
  same page probe (the same marks and the same press-then-click on an inbox row) with a fixed
  rotation through the four nodes in a fresh context. With one connection every cross-node switch
  is cold, so the before arm keeps the harness. A switch counts as cold when the Hub recorded a new
  client stream for it.
- Medians pool the blocks: per delay and arm 24 warm cross-node switches and 9 same-node controls
  at D = 0 and 40 (8 and 3 at D = 20 and 80), 27 (D = 0) and 24 (D = 40) switches back to an opened
  thread, 30 cold switches at D = 0 and 40 (10 at D = 20 and 80), and 30 fresh and 30 visited cold
  loads (10 at D = 80).
- 1-minute load average 4.0–13.5 (median 6.1). Other jobs and system indexing ran on the machine,
  which is why the arms alternate. No measured switch timed out or failed. Twice the whole fixture
  stalled for two to four minutes during a cold-load run, after which the nodes registered with
  the Hub again; one fresh cold load is left out for it (see "Against the targets").

### Against the targets

"Base commit" is the earlier session's cross-node switch (see "Baseline (base commit)"); "after
wave 2" is the before arm of this session. ms after the click, median (min–max).

Warm switch: nodes 1–3 online, so every final-arm cross-node switch goes to a node the tab keeps
connected. Each switch opens a thread the tab has not shown yet. n = 24 per arm at D = 0 and 40,
8 at D = 20 and 80. Targets: click task at most 150, content at most 200, writable at most 250
(each ±10%).

| D   | Metric     | Base commit | After wave 2          | Final           | Target | Result                                    |
| --- | ---------- | ----------- | --------------------- | --------------- | ------ | ----------------------------------------- |
| 0   | Click task | 1,019       | 198 (181–2,197)       | 120 (95–131)    | 150    | met                                       |
| 0   | Content    | 1,366       | 353.5 (217–2,659)     | 147 (116–164)   | 200    | met                                       |
| 0   | Writable   | 1,504       | 363 (328–2,659)       | 147 (116–164)   | 250    | met                                       |
| 20  | Click task | 1,060       | 199 (184–224)         | 119.5 (112–127) | 150    | met                                       |
| 20  | Content    | 1,612       | 586 (215–627)         | 202 (136–206)   | 200    | met (+1%)                                 |
| 20  | Writable   | 1,642       | 586 (564–627)         | 202 (136–206)   | 250    | met                                       |
| 40  | Click task | 1,042       | 198 (185–219)         | 118.5 (109–132) | 150    | met                                       |
| 40  | Content    | 1,759       | 826.5 (210–880)       | 285 (128–298)   | 200    | missed: one browser-node round trip (4·D) |
| 40  | Writable   | 1,766       | 831.5 (813–880)       | 285 (128–298)   | 250    | missed (+14%): the same round trip        |
| 80  | Click task | 1,074       | 191 (186–197)         | 117 (111–125)   | 150    | met                                       |
| 80  | Content    | 2,058       | 1,309.5 (210–1,314)   | 441 (131–445)   | 200    | missed: one browser-node round trip (4·D) |
| 80  | Writable   | 2,112       | 1,309.5 (1,292–1,314) | 441 (131–445)   | 250    | missed: the same round trip               |

- No final-arm warm switch opened a Hub stream, issued a ticket, opened a node channel or reached a
  node's shell subscription (64 of 64 over the four delays). After wave 2 every cross-node switch
  does all four (the bound of one), and all but a few show it in the window attributed to the
  switch: for 3 at D = 0 the Hub's audit shows no stream there, and for 7 at D = 0 and 4 at D = 40
  the node shows no channel open or shell subscription there, although their timing is that of
  the others.
- The warm environment is writable as soon as the thread shows: content and writable are equal in
  every final-arm warm switch. What is left at D > 0 is the thread's messages: a thread the tab has
  not shown yet costs one browser-node round trip (4·D, 160 ms at D = 40 and 320 ms at D = 80)
  for its window. The fastest switches (128–136 ms) found the thread's window already in memory.
- The warm target is judged on this table: a switch to a thread the tab has not shown yet, which
  is what the switch probe does. It holds up to D = 20 (202 ms, inside the ±10%) and is missed from D = 40 on, because its fixed
  budget leaves no room for the window's round trip. A switch back to a thread the tab has shown
  before (next table) meets it at D = 0 and 40, the delays measured.
- Follow-up: start fetching the thread's window when its row is pressed, as the node's connection
  already is for a cold switch, so that the round trip overlaps the 117–120 ms click task instead
  of following it; and keep the windows of each warm environment's most recently active threads in
  memory, so that more of these switches are revisits. At D = 80 the round trip alone is above the
  content target, so for a thread not shown yet the target would have to grow with D (200 + 4·D
  content, 250 + 4·D writable).

Switching back to a thread already opened (3 rounds over threads on the three nodes, row clicks
only; n = 27 at D = 0 and 24 at D = 40 per arm):

| D   | Metric     | After wave 2  | Final           | Target | Result |
| --- | ---------- | ------------- | --------------- | ------ | ------ |
| 0   | Click task | 197 (171–809) | 118 (105–133)   | 150    | met    |
| 0   | Content    | 215 (186–820) | 139 (129–160)   | 200    | met    |
| 0   | Writable   | 347 (306–974) | 139 (129–160)   | 250    | met    |
| 40  | Click task | 203 (170–231) | 121.5 (96–383)  | 150    | met    |
| 40  | Content    | 217 (194–246) | 141.5 (114–408) | 200    | met    |
| 40  | Writable   | 820 (787–856) | 141.5 (114–408) | 250    | met    |

After wave 2 the thread shows from memory, but the switch is writable only after a new stream
and shell (one channel). In the final arm 50 of 51 returns opened no stream; the one that did
directly followed a return the probe had to navigate (at D = 40 it leaves the first node before it
has loaded, so the first return to it is left out of both arms).

Cold switch: node 4 online as well, so the final arm keeps returning to a node it released; only
switches that opened a Hub stream count (18 of 30 at D = 0 and 40, 6 of 10 at D = 20 and 80; the
others found the node still warm, 163.5 ms writable at D = 0). Target: writable at most 12·D + 600.

| D   | Base commit | After wave 2          | Final                 | Delta | Target | Result |
| --- | ----------- | --------------------- | --------------------- | ----- | ------ | ------ |
| 0   | 1,504       | 399 (367–431)         | 343 (312–394)         | -56   | 600    | met    |
| 20  | 1,642       | 622 (602–649)         | 587 (543–610)         | -35   | 840    | met    |
| 40  | 1,766       | 873 (835–897)         | 816.5 (783–854)       | -56.5 | 1,080  | met    |
| 80  | 2,112       | 1,355.5 (1,334–1,387) | 1,307.5 (1,280–1,319) | -48   | 1,560  | met    |

- The final arm is 35–56.5 ms faster at every delay. Its click task is 23–41 ms shorter (195–200
  against 223–237.5 ms, median), and the press on the row starts the node's connection before that
  task runs. A cold switch's click task is longer than a warm one's (117–120 ms) and stays within
  its 250 ms target.
- The previous session measured the wave-2 tip at 306 and 760.5 ms writable at D = 0 and 40 with
  two nodes. With four nodes the inbox lists about 320 rows instead of 157 and the click task is
  longer (233 against about 150 ms), which accounts for most of the difference.

Same-node controls, content (ms). Target: at most 200.

| D   | Base commit | After wave 2 | Final        | Result                                            |
| --- | ----------- | ------------ | ------------ | ------------------------------------------------- |
| 0   | 469         | 45 (31–158)  | 38 (25–46)   | met                                               |
| 20  | 526         | 107 (32–107) | 104 (28–108) | met                                               |
| 40  | 475         | 44 (27–189)  | 182 (28–210) | met by 8 of 9; a window not in memory costs 4·D   |
| 80  | 536         | 347 (36–348) | 347 (28–350) | missed: a window not in memory costs 4·D (320 ms) |

A same-node window already in memory shows in 25–46 ms at every delay in both arms; one that is
not costs one browser-node round trip. Which of the three controls hit one or the other differs by
run (4 of 9 against 5 of 9 at D = 40), so the medians at D = 40 and 80 move with that split, not
with the revision. Follow-up: as for the warm switch, start the window's fetch when the row is
pressed (on an environment that is already connected this needs no ticket); at D = 80 the round
trip alone (320 ms) is above the target, so for a window not in memory the target would have to
become 200 ms plus that round trip.

Click task and render budget. Target: at most 250 ms for every cross-node switch (met at every
delay, see above), at most 150 ms for a warm one (met), and at most 200 ms of long task in a
same-node switch: no final-arm same-node control had a long task at D = 0, 20 or 80, and one at
D = 40 had one of 116 ms (met). The profiled warm switch at D = 0 (one per arm, profiling stretches
the task):

| Self time inside the click task, ms       | After wave 2 | Final |
| ----------------------------------------- | ------------ | ----- |
| Whole task while profiled                 | 196          | 123   |
| React DOM                                 | 61           | 36.9  |
| Base UI                                   | 48.8         | 33.1  |
| All inbox sidebar code                    | 11           | 6.9   |
| Inbox row presentation and row component  | 3            | 2.8   |
| Chat view                                 | 4.3          | 1.1   |
| Message timeline and the git actions menu | 0.5          | 0     |
| Garbage collection                        | 12.3         | 4.1   |

The profiled same-node switch had no long task in either arm.

Send accepted: ms from pressing Enter until the composer clears or a queued row shows. Target: at
most 100.

| Send                                    | D      | After wave 2            | Final                 | Result                               |
| --------------------------------------- | ------ | ----------------------- | --------------------- | ------------------------------------ |
| To a writable thread (`--send`), direct | 0      | 121 (26–140), n = 24    | 120 (115–128), n = 24 | missed: waits for the list to scroll |
| To a writable thread (`--send`), direct | 40     | 118.5 (114–126), n = 24 | 119 (116–125), n = 24 | missed: the same                     |
| During a cold switch, queued            | 0      | 7 (7–11), n = 5         | none: writable first  | not exercised                        |
| During a cold switch, queued            | 40     | 7 (6–21), n = 24        | 8 (6–65), n = 12      | met                                  |
| During a cold switch, queued            | 20, 80 | 7 (7–25), n = 16        | 7.5 (6–8), n = 8      | met                                  |

- The direct send still waits for the message list to finish scrolling to its end (110–130 ms):
  the chat layout change in this round did not move it. It does not grow with D. Follow-up: show
  the sent message and clear the composer before the scroll settles.
- During a switch the queued row shows 7–8 ms after Enter in both arms. In the final arm only the
  switches that went cold were still connecting when Enter was pressed (12 of 24 at D = 40, 8 of 16
  at D = 20 and 80; at D = 0 every switch was writable before the probe had typed, against 19 of
  24 after wave 2).

Cold load, first content (ms from navigation start, n = 30 per arm at D = 0 and 40, 10 at D = 80).
Targets: at most 700 at D = 0; at most 3,000 at D = 40 (stretch 2,500).

| D   | Profile | Base commit | After wave 2          | Final               | Delta  | Target | Result                           |
| --- | ------- | ----------- | --------------------- | ------------------- | ------ | ------ | -------------------------------- |
| 0   | fresh   | 788         | 533.5 (489–3,305)     | 504 (473–567)       | -29.5  | 700    | met                              |
| 40  | fresh   | 3,472       | 3,268 (3,225–3,337)   | 2,974 (2,930–4,427) | -294   | 3,000  | met; stretch (2,500) missed      |
| 80  | fresh   | 6,176       | 6,017 (6,001–6,045)   | 5,479 (5,455–5,490) | -538   |        | reported                         |
| 0   | visited |             | 335.5 (326–388)       | 352.5 (326–397)     | +17    |        | reported (block medians overlap) |
| 40  | visited |             | 965.5 (941–1,005)     | 905 (864–1,212)     | -60.5  |        | reported                         |
| 80  | visited |             | 1,628.5 (1,618–1,639) | 1,477 (1,454–1,488) | -151.5 |        | reported                         |

Round trips, `(first content at D = 40 − at D = 0) / 80 ms`. Target: at most 28.6 (the base
commit's 33.6 minus 5).

| Profile | Base commit | After wave 2 | Final | Target | Result                                      |
| ------- | ----------- | ------------ | ----- | ------ | ------------------------------------------- |
| fresh   | 33.6        | 34.2         | 30.9  | 28.6   | missed: queueing on six connections remains |
| visited |             | 7.9          | 6.9   |        |                                             |

Where a fresh load spends its time, from 8 more loads per arm and delay with a per-request
timeline (ms from navigation start, median):

| D   | Arm          | First content | Access check (session, directory) | Account socket opens | Thread route ready | Shell snapshot received | Shell painted |
| --- | ------------ | ------------- | --------------------------------- | -------------------- | ------------------ | ----------------------- | ------------- |
| 0   | After wave 2 | 534.5         | 129 to 223                        | 251                  | 268                | 334                     | 502           |
| 0   | Final        | 531.5         | 116 to 119                        | 135                  | 252                | 323                     | 498           |
| 40  | After wave 2 | 3,261         | 290 to 2,408                      | 2,433                | 2,913              | 3,070                   | 3,229         |
| 40  | Final        | 2,993         | 279 to 363                        | 365                  | 2,648              | 2,788                   | 2,959         |
| 80  | After wave 2 | 6,012.5       | 459 to 4,588                      | 4,613                | 5,575              | 5,817.5                 | 5,976         |
| 80  | Final        | 5,478         | 442 to 606                        | 608                  | 5,055              | 5,269                   | 5,445         |

"Thread route ready" is the end of the root route's load, which waits for the thread route's code.

- The cold load is about 3.3 browser-Hub round trips shorter (30.9 against 34.2 in this session,
  31.1 against 34.3 from D = 0 to 80). The access check now answers in one round trip and the
  account socket opens right after it, 2 to 4 s earlier at D = 40 and 80, and a load makes
  217–226 requests (239–249). The shell snapshot still waits for the thread route's code: the
  route is ready 2.6 s after navigation at D = 40, and the snapshot arrives about 140 ms later in
  both arms. That code queues on the browser's six connections per origin over plain HTTP/1.1,
  together with the second node-directory request of every load (447 to 2,226 ms at D = 40), which
  is most of the remaining 31 round trips and why the round-trip target is missed. Behind an
  HTTP/2 front end those requests are multiplexed. Follow-up: group the rest of the thread route's
  module closure into fewer chunks (the first item of the earlier cut list), make the second
  directory request conditional, and measure behind an HTTP/2 proxy as well.
- The cold-load change measured its own interleaved before and after on the same kind of fixture:
  506 and 2,959 ms at D = 0 and 40, against 528 and 3,259 ms. Its change set is the one that
  merged, and this session agrees (504 and 2,974 ms).
- `serialRoundTrips` of the harness stays at 1–3 in both arms: it counts from the last response
  before first content, which is a late, lazily loaded chunk.
- One final-arm fresh load at D = 40 timed out (no first content within 30 s); it is left out of
  the median. During it the whole fixture stalled: the Hub logged nothing for about two minutes,
  and then all three nodes registered with it again. Two loads shortly after it took 3.8 and 4.4 s
  and stay in the range. Three before-arm loads at D = 0 took 1.5–3.3 s in a run that ended in a
  similar stall of about four minutes, and stay in the range as well.

### Warm set qualification

The change that raised the hosted warm set to three recorded its own qualification, on the same kind
of local fixture, in
[Hosted Web warm set qualification (measured)](./relay-capacity-assessment-3b.md#hosted-web-warm-set-qualification-measured).
It was not measured again here. Its summary, per check:

| Check                                   | Bound of one                                | Warm set of three                                                             | Result                                                                      |
| --------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Traffic per warm environment            | 52 B/s per tab, idle, on its one connection | +58 B/s idle per extra warm environment; +2.9 KB/s while one of them streams  |                                                                             |
| Browser memory, three nodes against one | 213 and 803 MiB after three nodes           | 0.98× and 1.00× of the bound of one (1,000 and 4,500 threads)                 | missed as written in both bounds: the inbox keeps every visited node's rows |
| Node cost per idle channel              | 0.02 MiB RSS, about 0.015% of one core      | the same per channel                                                          |                                                                             |
| Wake and Hub restart, up to 8 tabs      | no rate limiting; one stream per tab        | no rate limiting; a restart turned 24 warm streams into 8                     | met                                                                         |
| Warm switch                             | click 197, content 352, writable 356 ms     | click 132, content 158, writable 158 ms; no Hub stream, no node shell request | met                                                                         |
| Four simultaneous foreground wakes      | at most 2 channels per node                 | at most 4 channels per node, at most 2 opens per node in any second           | met                                                                         |

This session's long-task run (see "Memory") agrees: a tab warm on three nodes carried 160 B/s idle
and 3.06 KB/s while a node out of view streamed. The idle traffic per warm stream is the input for
the deferred decision on the keepalive interval of warm streams.

### Relay drops

The relay-drop probe of "After wave 1": the tab first opens a thread on nodes 2 and 3, then 10
threads of node 1 in a row and the routed thread, so the final arm holds a warm environment on each
node and demands only node 1's. Restarting the delay proxy then drops every relay connection at
once, the nodes' included; three drops 12–14 s apart per run, three runs per arm, D = 0, with
fresh node processes before every run. ms after the drop, median (min–max), n = 3:

| Drop | Arm          | Writable again       | Node back on the Hub | Retry gap (writable − node back) | Client streams per drop |
| ---- | ------------ | -------------------- | -------------------- | -------------------------------- | ----------------------- |
| 1st  | After wave 2 | 1,379 (1,310–3,067)  | 1,096 (869–1,100)    | 510 (210–1,971)                  | 1, 1, 1                 |
| 1st  | Final        | 1,336 (1,090–3,290)  | 874 (839–1,159)      | 462 (251–2,131)                  | 1, 1, 1                 |
| 2nd  | After wave 2 | 5,727 (4,778–6,248)  | 2,239 (2,047–2,301)  | 3,488 (2,731–3,947)              | 1, 1, 1                 |
| 2nd  | Final        | 3,672 (1,981–7,108)  | 1,984 (1,693–2,418)  | 1,688 (288–4,690)                | 1, 1, 1                 |
| 3rd  | After wave 2 | 7,337 (6,820–8,625)  | 4,571 (3,922–4,772)  | 2,766 (2,048–4,703)              | 1, 1, 1                 |
| 3rd  | Final        | 9,632 (9,227–10,316) | 4,143 (3,260–4,535)  | 5,967 (5,097–6,173)              | 1, 1, 1                 |

- "Node back" is the node's first relay authentication on the Hub after the drop. The nodes come
  back later at every drop (about 1, 2 and 4 s), and the client's own retry comes later still: on
  the first drop about 0.5 s after the node, on later drops 1.7–6 s after it, because the client
  waits out its backoff although the node is already there. Wave 1 measured 1.05–1.30 s to
  writable on the first drop and 1.9–12.2 s on later ones; this round is the same within the
  spread.
- Every drop cost exactly one client stream in both arms: in the final arm only the demanded
  environment reconnected, and the two warm environments without a view were released, not
  reconnected. The page stayed responsive (0.21–0.46 s of main-thread tasks during a recovery).
- Follow-up: retry a demanded environment soon after its node is back instead of waiting out the
  backoff (the 1.7–6 s retry gaps above are the starting point).
- An earlier set of three runs per arm, with node processes that had been through the session's
  earlier proxy restarts, saw nodes come back after up to 60 s (the nodes' backoff ceiling);
  writable followed the node, and 3 of 15 drops were not writable within the 45 s observed. Those
  runs are left out of the table.

### Before the next changes

Two behaviors that later changes target, measured at the final tip as their starting point.

Foreground restore. One tab opens a thread on each of nodes 1, 2 and 3 (warm on all three, node 3
in view), goes offline for 10 s and comes back; then it clicks the threads it had open on the two
nodes out of view. Three rounds, D = 0:

| What                                   | Final                                            |
| -------------------------------------- | ------------------------------------------------ |
| Routed thread writable after the wake  | 183 ms (175–187)                                 |
| Switch to an out-of-view node, content | 201.5 ms (158–261), n = 6                        |
| The same switch, writable              | 274.5 ms (239–353), n = 6                        |
| Hub streams and tickets per switch     | at least one in 6 of 6; a warm switch opens none |
| Node shell subscriptions per switch    | at least one in 6 of 6                           |

After a wake the routed environment comes back and the other two warm environments stay released,
so a switch to either is a cold switch (the thread itself still shows from memory first). Restoring
the previous warm set after a wake would make these switches warm again (writable in about 150 ms,
see "Against the targets").

First read on a cold switch. In the D = 40 cold switches that opened a stream (18 in the final arm,
30 after wave 2), the target node's RPC spans after the click, ms (median, min–max):

| Request on the target node                                   | After the click, final | After the shell subscription, final | After wave 2, after the shell subscription |
| ------------------------------------------------------------ | ---------------------- | ----------------------------------- | ------------------------------------------ |
| Shell subscription                                           | 596 (580–644)          | 0                                   | 0 (656 after the click)                    |
| Thread window, VCS status, terminal and server subscriptions | 598–599                | 2–3                                 | 2–3                                        |
| Local tasks list and change subscription                     | 849 (823–901)          | 249 (240–265)                       | 250 (236–256)                              |
| Change requests list (3 of 18; after wave 2 in 18 of 30)     | 895 (875–900)          | 254 (249–257)                       | 249 (235–254)                              |
| Project icon read (3 of 18)                                  | 897 (875–901)          | 256 (250–258)                       | not issued                                 |
| Writable, for reference                                      | 816.5                  | 222                                 | 215                                        |

The streaming subscriptions (thread window, VCS status) go out together with the shell
subscription. The one-shot reads reach the node about 250 ms after it, 27 ms after the thread is
writable: the client sends them only once it has received and accepted the node's shell, so at
D = 40 they wait for the shell's way to the browser and their own way back (80 ms each) plus the
acceptance. The fixture issues no history or file reads on a switch. At D = 0 the same reads follow
the shell subscription by 93 ms (82–116).

### Memory

One tab opens 100 listed threads of the 2,000-thread node in a row (in-app navigation, each until
its messages show), then stays idle for 7 minutes, longer than the 5-minute window in which a
recently opened thread keeps its body and long enough for the 60-second check of a store left over
budget. Two runs per arm; every session is `ready`, as generated, which now counts as idle. The JS
heap is measured after a garbage collection; bodies are counted in the store's message index of a
heap snapshot taken after the idle period.

| Metric                                            | After wave 2              | Final                     | Delta | Target                     | Result |
| ------------------------------------------------- | ------------------------- | ------------------------- | ----- | -------------------------- | ------ |
| Web JS heap after 1 / 32 / 64 / 100 threads (MiB) | 32.4 / 60.4 / 80.1 / 97.2 | 31.6 / 41.5 / 45.7 / 49.4 | -47.8 |                            |        |
| Web JS heap after 7 minutes idle (MiB)            | 96.3–97.8                 | 47.7–47.8                 | -49   |                            |        |
| Thread bodies in the store after 7 minutes idle   | 171–172 (100 opened)      | 64 in both runs           | -108  | at most 64, plus protected | met    |
| Message ids in those bodies                       | 1,440–1,442               | 526                       | -915  |                            |        |

- The final arm's heap is already 19 MiB lower after 32 threads and grows by about 0.1 MiB per
  further thread (0.55 MiB after wave 2). After the idle period nothing is protected any more and
  the store keeps exactly its budget: the most recently opened threads and 27 threads the tab never
  opened.
- In the before arm no body is evicted, as in earlier rounds.
- The earlier count, the threads whose first reply's id is still anywhere in the heap, stays at 88
  of 88 in both arms, so it no longer counts bodies: in the final arm those ids stay referenced
  from small per-turn records, and in one traced case from a message array that a module-level
  value keeps after its thread was evicted. Follow-up: find which memo keeps that array, and count
  bodies from the store index from now on.

Long tasks while a warm node streams. One tab opens a thread on nodes 1, 2 and 3 and stays on node
3, warm on the other two. For 5 minutes a second context sends a message every 2 seconds into a
thread of node 1, out of view (150 messages); a 5-minute idle window comes first. Final arm, D = 0:

| Window                          | Long tasks per minute | Long-task time per minute | Traffic of the tab (in / out) |
| ------------------------------- | --------------------- | ------------------------- | ----------------------------- |
| Idle                            | 0                     | 0 ms                      | 81 / 79 B/s                   |
| A warm node out of view streams | 0                     | 0 ms                      | 2,717 / 344 B/s               |

The updates of a warm node out of view cost the tab no long task.

### Node

The node code is the same in both arms, so these rows were measured once, at the final tip, with
the final arm's bundle (nodes 1–3 online, D = 0). "Wake-ups" are context switches of the node
process, a proxy for timer wake-ups.

| Row                                                          | After wave 0  | Final                                                            | Target                      | Result                     |
| ------------------------------------------------------------ | ------------- | ---------------------------------------------------------------- | --------------------------- | -------------------------- |
| Node RSS, idle, no client                                    | 275–279 MiB   | 260–291 MiB (three nodes)                                        |                             |                            |
| Node wake-ups per second, idle, no client                    | 1.8–1.9       | 1.3 (1.29–1.34); 6.3–6.5 in the first minute after a Hub restart |                             |                            |
| Wake-ups per idle subscription per second (10 subscriptions) | 0.26          | 0.06                                                             | no recurring timer wake-ups | met                        |
| RSS of the node holding the 10 subscriptions                 |               | 276 MiB (+16 MiB)                                                |                             |                            |
| `ps` spawns per minute with one idle terminal                | 12, then 2    | 13 in the first idle minute, then 2                              | at most 2 after a minute    | met after the first minute |
| Codex status probe process starts while the reader lives     | not exercised | not exercised                                                    | 0                           | not exercised              |

- Subscriptions: one tab opens 10 threads of node 1 in a row and stays idle; node 1 then wakes
  1.89 times per second against 1.29 for node 2 in the same window (no client) and 1.34 for node 1
  after the tab closed, about 0.06 per subscription, consistent with keepalive traffic on the open
  channel rather than timers.
- The fixture nodes run with every provider disabled, so no Codex status probe runs at all; the
  path that reuses the long-lived reader was not exercised, as after wave 0.
- The first idle window started 40 s after a Hub restart that the nodes had just reconnected to;
  the later windows are the settled value.

### Desktop

Not measured on a native client: the local fixture cannot sign in a native client, and a run
against the production Hub needs the owner's interactive sign-in and enrolls the desktop as a device
on a real account. Both rows stay manual production checks (see "Production (manual)"). The evidence
is the desktop tests at the final tip: 144 pass in the relay, handshake, prekey, security helper,
background signal, content cache and workspace IPC suites, and 28 in the renderer's workspace
suite.

| Row                                               | Target                                     | Evidence                                                                         |
| ------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------- |
| Relay upgrades on Cmd-Tab or window blur          | 0, with warm connections kept              | met in the tests (focus loss never backgrounds the workspace); not measured live |
| Cold remote connect                               | 50–130 ms faster, one key read per process | the tests show the trimmed connect order; time not measured                      |
| Cold app start to the first cached thread content |                                            | the tests show cached conversations painted before live data; time not measured  |

### Mobile

Not measured on a device, for the same reason. The evidence is the mobile tests at the final tip:
192 pass in the thread connection retarget, home catalog model, node lifecycle, connection
coordinator, primary connection, retained wake, snapshot persistence, snapshot codec, snapshot
database and preferences suites (44 of them in the first two, which this round changed).

| Row                                               | Target                                  | Evidence                                                                           |
| ------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------- |
| Re-selecting a warm node                          | 0 network calls, mutation-ready at once | met in the tests, now without the retarget debounce; time on a device not measured |
| Cold app start to the first cached thread content |                                         | the tests show cached messages before any live data; time not measured             |
| Directory polls per hour                          |                                         | not measured: the change that makes polling demand-driven lands after this round   |
| Native cipher decrypt time per MiB                |                                         | not applicable: the native cipher change was not taken                             |

- Warm re-select: opening a thread on a node whose session is warm (connecting or established)
  dispatches its open at once instead of waiting out the retarget debounce, which a node without a
  warm session keeps; the home catalog model derives every node's connection state with the shared
  rule.

## After waves 4 and 5 (final)

Revision: the wave-3 tip plus the fifth and sixth sets of changes. On the switch path: hosted web
restores its last warm set when it returns to the foreground (after the hidden grace period, a page
freeze or going offline), a remembered browser restores the machines it cached once it has booted,
and returning to the home screen re-warms the recently used ones; observe-only reads (project lists
and files, local changes, thread history and diffs, the node's config and settings) are answered
once the channel is encrypted, before the shell snapshot; a demanded environment waiting out its
relay backoff retries as soon as the directory reports its node online again; a direct send clears
the composer and shows the message before the transcript scrolls to its end; a read that already
succeeded on the session's current connection is not fetched again when the session becomes ready;
a thread row's press or hover fetches the thread's window only from a session that is ready; and
evicting a thread body also releases the module-level memos of its composed content. Outside it:
mobile polls the node directory only while presence is on screen, unused modules and exports were
removed, and every Effect package moved to 4.0.5.

Setup, as under "After wave 3" except:

- Two arms, interleaved in one session: "before" is the wave-3 tip and "final" this tip. The
  Effect upgrade reaches the server too, so every block restarts the nodes from its arm's revision
  as well as the Hub with its arm's bundle. One Hub data directory, one owner and one set of node
  homes serve both arms (no schema change between them).
- Every probe runs from the final tip in both arms. Its switch probe changed: it presses a row in
  one task and releases and clicks it in a later one, as a pointer does, where it did both in one
  task before, and server-side evidence of a switch is counted from the press. A press already
  starts the thread window's fetch on a warm environment in both arms; with the press in its own
  task that request now leaves before the click's long task instead of after it. Both arms move by
  it, so the rows that depend on it (a warm switch to a thread not shown yet, a same-node window
  not in memory) are not comparable with the earlier sessions: compare the two arms of this
  session.
- Blocks: before, final, three times at D = 0 and 40; one block per arm at D = 20 and 80. Per
  block and delay, with nodes 1–3 online: one `hosted-switch --send` run (8 cross-node switches,
  every one to a warm node, and 3 same-node controls); at D = 0 and 40, 3 rounds of switching back
  to threads already opened on the three nodes; at D = 0, 40 and 80, 10 fresh and 10 visited cold
  loads. Then with node 4 online, at every delay: 10 cross-node switches with the fixed rotation
  through the four nodes (both arms keep a warm set of three, so both use it) and a
  send-during-switch run with 8 switches. Then, per arm at D = 0: the node rows, the restore
  probes, the relay drops and the memory runs.
- A press on a row of a node the tab holds no connection for re-renders that row before the
  release (see "Pressing a row of a node that is not connected"), so the page probes of this
  session click the row element that is in the document at click time. `hosted-switch` clicks the
  element it pressed; that only matters for such switches, and all of its switches here are warm.
- Medians pool the blocks: per delay and arm 24 warm cross-node switches and 9 same-node controls
  at D = 0 and 40 (8 and 3 at D = 20 and 80), 27 (D = 0) and 24 (D = 40) switches back to an opened
  thread, 15 cold switches at D = 0 and 40 (5 at D = 20 and 80), and 30 fresh and 30 visited cold
  loads (10 at D = 80).
- 1-minute load average 2.9–11.9 (median 5.1). No measured switch, send or load timed out or
  failed.

### Against the targets

ms after the click, median (min–max), "before" against "final".

Warm switch to a thread the tab has not shown yet: nodes 1–3 online, so every cross-node switch
goes to a node the tab keeps connected. n = 24 per arm at D = 0 and 40, 8 at D = 20 and 80.
Targets: click task at most 150, content at most 200, writable at most 250 (each ±10%).

| D   | Metric     | Before          | Final           | Target | Result                                         |
| --- | ---------- | --------------- | --------------- | ------ | ---------------------------------------------- |
| 0   | Click task | 120.5 (107–132) | 121.5 (115–136) | 150    | met                                            |
| 0   | Content    | 150 (129–165)   | 149 (135–163)   | 200    | met                                            |
| 0   | Writable   | 150 (129–165)   | 149 (135–163)   | 250    | met                                            |
| 20  | Click task | 114 (112–123)   | 120.5 (116–132) | 150    | met                                            |
| 20  | Content    | 141.5 (137–149) | 148 (141–157)   | 200    | met                                            |
| 20  | Writable   | 141.5 (137–149) | 148 (141–157)   | 250    | met                                            |
| 40  | Click task | 118.5 (110–133) | 119 (114–133)   | 150    | met                                            |
| 40  | Content    | 183 (131–192)   | 185 (132–193)   | 200    | met                                            |
| 40  | Writable   | 183 (131–192)   | 185 (132–193)   | 250    | met                                            |
| 80  | Click task | 117 (109–128)   | 117.5 (114–124) | 150    | met                                            |
| 80  | Content    | 344 (132–352)   | 346 (133–349)   | 200    | missed: the window's round trip alone (320 ms) |
| 80  | Writable   | 344 (132–352)   | 346 (133–349)   | 250    | missed: the same round trip                    |

- No warm switch in either arm opened a Hub stream, issued a ticket, opened a node channel or
  reached a node's shell subscription (64 of 64 per arm), and content and writable are equal in
  every one.
- The thread window's request reaches the node 3 ms after the click at D = 0 and 2·D + 3–5 ms after
  it at the other delays (43–45, 83–84 and 164 ms), in both arms: it leaves at the press, before
  the click's long task (107–136 ms), and the window is back one browser-node round trip (4·D) after
  the press. Content is therefore the larger of the click task and 4·D, plus about 25–30 ms of
  render: about 150 ms up to D = 20, 185 ms at D = 40 and 345 ms at D = 80.
- The earlier session measured the wave-3 tip at 285 ms (D = 40) and 441 ms (D = 80), with the old
  probe, whose press and click ran in one task, so the request left only after the click task. The
  before arm here, the same revision, shows 183 and 344 ms. That difference is the probe's (a
  pointer's press comes one task before its click), not a change in the product.
- The target is met up to D = 40 and missed at D = 80, where one browser-node round trip alone
  exceeds it. For a thread not shown yet a content budget of 4·D + 50 ms holds once 4·D is longer
  than the click task (370 ms at D = 80). Follow-up, as before: keep the windows of each warm
  environment's most recently active threads in memory, so that more of these switches are
  revisits (next table).

Switching back to a thread already opened (3 rounds over threads on the three nodes, row clicks
only; n = 27 at D = 0 and 24 at D = 40 per arm):

| D   | Metric     | Before          | Final           | Target | Result |
| --- | ---------- | --------------- | --------------- | ------ | ------ |
| 0   | Click task | 118 (99–133)    | 122 (108–139)   | 150    | met    |
| 0   | Content    | 141 (127–161)   | 144 (126–165)   | 200    | met    |
| 0   | Writable   | 141 (127–161)   | 144 (126–165)   | 250    | met    |
| 40  | Click task | 121.5 (110–130) | 120 (107–141)   | 150    | met    |
| 40  | Content    | 141 (129–154)   | 139.5 (128–157) | 200    | met    |
| 40  | Writable   | 141 (129–154)   | 139.5 (128–157) | 250    | met    |

No return opened a stream or requested the thread's window again. As in the earlier session, the
first return of each run at D = 40 is navigated (the probe leaves the first node before it has
loaded) and left out of both arms.

Cold switch: node 4 online as well, so a switch to the node the tab released last is cold; only
switches that opened a Hub stream count (15 of 30 at D = 0 and 40, 5 of 10 at D = 20 and 80; the
others found the node still warm). Target: writable at most 12·D + 600.

| D   | Before              | Final               | Delta | Target | Result |
| --- | ------------------- | ------------------- | ----- | ------ | ------ |
| 0   | 348 (240–382)       | 355 (262–392)       | +7    | 600    | met    |
| 20  | 585 (416–609)       | 587 (414–621)       | +2    | 840    | met    |
| 40  | 838 (643–885)       | 838 (640–878)       | 0     | 1,080  | met    |
| 80  | 1,317 (1,137–1,330) | 1,314 (1,134–1,360) | -3    | 1,560  | met    |

- Unchanged, as expected: neither wave changed a cold switch's round trips (the early reads are
  not on its critical path, see "First read on a cold switch"). The earlier session measured the
  wave-3 tip at 343, 587, 816.5 and 1,307.5 ms.
- A cold switch's click task is 196–200 ms in both arms (a warm one's 117–122 ms).
- At D = 0, 6 (before) and 5 (final) of the 15 cold switches opened their stream during the press,
  whose task then took 100–125 ms, and were writable at 240–308 ms; the others opened it after the
  click and were writable at about 355 ms. At the other delays every cold switch opened its stream
  after the click.

Same-node controls, content (ms). Target: at most 200.

| D   | Before       | Final        | Result                                                    |
| --- | ------------ | ------------ | --------------------------------------------------------- |
| 0   | 35 (27–50)   | 38 (28–49)   | met                                                       |
| 20  | 106 (34–109) | 102 (33–105) | met                                                       |
| 40  | 182 (20–192) | 38 (25–189)  | met, also by every control whose window was not in memory |
| 80  | 341 (33–354) | 352 (31–353) | missed: a window not in memory costs 4·D (320 ms)         |

A same-node window already in memory shows in 20–50 ms at every delay. One that is not now costs
4·D plus about 25 ms (its request leaves at the press, and a same-node click has no long task):
about 105 ms at D = 20, 182–192 ms at D = 40 and 341–354 ms at D = 80. The D = 40 medians differ
only by how many of the 9 controls found their window in memory (4 before, 5 final).

Send accepted: ms from pressing Enter until the composer clears or a queued row shows. Target: at
most 100.

| Send                                    | D      | Before                | Final              | Result |
| --------------------------------------- | ------ | --------------------- | ------------------ | ------ |
| To a writable thread (`--send`), direct | 0      | 119 (27–129), n = 24  | 11 (10–29), n = 24 | met    |
| To a writable thread (`--send`), direct | 20     | 121 (116–127), n = 8  | 15 (12–30), n = 8  | met    |
| To a writable thread (`--send`), direct | 40     | 119 (118–130), n = 24 | 12 (10–30), n = 24 | met    |
| To a writable thread (`--send`), direct | 80     | 121 (117–127), n = 8  | 15 (13–24), n = 8  | met    |
| During a cold switch, queued            | 40     | 7 (6–20), n = 12      | 7.5 (5–21), n = 12 | met    |
| During a cold switch, queued            | 20, 80 | 7 (6–19), n = 7       | 7 (6–17), n = 7    | met    |

- The direct send no longer waits for the message list to scroll to its end: the composer clears
  11–15 ms after Enter (median) at every delay, against 119–121 ms before.
- A send queued during a switch shows its message as soon as the thread turns writable (median 0
  ms after it at D = 40, at most 38 ms at any delay), where it showed 99–153 ms after it before.
- At D = 0 every switch was writable before the probe had typed, in both arms.

Cold load, first content (ms from navigation start, n = 30 per arm at D = 0 and 40, 10 at D = 80).
Targets: at most 700 at D = 0; at most 3,000 at D = 40 (stretch 2,500).

| D   | Profile | Base commit | Before                | Final                 | Delta | Target | Result                    |
| --- | ------- | ----------- | --------------------- | --------------------- | ----- | ------ | ------------------------- |
| 0   | fresh   | 788         | 531.5 (510–581)       | 508 (490–533)         | -23.5 | 700    | met                       |
| 40  | fresh   | 3,472       | 3,010.5 (2,977–3,056) | 3,034 (2,993–3,067)   | +23.5 | 3,000  | missed by 1% in both arms |
| 80  | fresh   | 6,176       | 5,578.5 (5,556–5,604) | 5,574.5 (5,551–5,619) | -4    |        | reported                  |
| 0   | visited |             | 361.5 (348–381)       | 362.5 (329–381)       | +1    |        | reported                  |
| 40  | visited |             | 909 (879–940)         | 926 (870–947)         | +17   |        | reported                  |
| 80  | visited |             | 1,502.5 (1,481–1,511) | 1,524 (1,480–1,529)   | +21.5 |        | reported                  |

Round trips, `(first content at D = 40 − at D = 0) / 80 ms`: 31.0 before and 31.6 final for a fresh
load (target at most 28.6, missed: queueing on six connections remains), 6.8 and 7.0 visited.

- Neither wave changed the cold load, and the Effect upgrade leaves it within the session's spread:
  the same 226 requests (2.07–2.08 MiB at D = 0, 2.31 MiB at D = 40) in both arms, and block
  medians at D = 40 of 2,999–3,035 ms before against 3,011–3,044.5 ms final.
- The D = 40 target, met by the wave-3 tip in the earlier session (2,974 ms), is missed by both
  arms here by 11–34 ms; the before arm, the same revision, ran 37 ms slower than then, which is
  this session's machine load rather than a revision difference. The follow-ups of "After wave 3"
  (fewer chunks for the thread route's module closure, a conditional second directory request, a
  measurement behind an HTTP/2 proxy) still apply.

### Warm set restore

Foreground restore: one tab opens a thread on each of nodes 1, 2 and 3 (warm on all three, node 3
in view), goes offline for 10 s and comes back, then clicks the rows of the threads it had open on
the two nodes out of view. Boot of a remembered browser: a tab with "Remember this browser" on opens
the same three threads, waits 8 s for the saved copy, reloads on node 3's thread (a new application
session) and, 5 s after the thread is writable again, clicks the rows of the threads it had open on
nodes 1 and 2. Three rounds of each per arm, D = 0; ms, median (min–max), n = 3 wakes or reloads
and 6 switches:

| What                                                    | Before          | Final           |
| ------------------------------------------------------- | --------------- | --------------- |
| After going offline: the routed thread writable again   | 172 (170–172)   | 195 (193–219)   |
| Then a switch to a node out of view, content            | 173 (164–182)   | 149.5 (138–165) |
| The same switch, writable                               | 238 (233–241)   | 149.5 (138–165) |
| Hub streams opened by those switches                    | one in 6 of 6   | none            |
| After the reload: content from the saved copy, writable | 481, 645        | 463, 650        |
| Then a switch to a recently used node, content          | 141.5 (118–175) | 139.5 (128–149) |
| The same switch, writable                               | 313.5 (290–329) | 139.5 (128–149) |
| Hub streams opened by those switches                    | one in 6 of 6   | none            |

- In the final arm the warm set comes back after the wake and after the reload: the two nodes out
  of view reconnect once the routed one has, so the switches to them open no stream, need no shell
  subscription and are writable with their content, like any warm switch. Before, both are cold
  switches whose thread shows first from memory or from the saved copy. Expected none in the final
  arm: met.
- Two final-arm switches have a stream in their window, opened about 1.9 s after the click when the
  probe's next round loaded a new page; they are not part of the switch.
- The routed thread's own recovery after the wake took 195 ms against 172 ms (three wakes each; the
  earlier session measured 183 ms for the wave-3 tip).

### First read on a cold switch

In the D = 40 cold switches (15 per arm), the target node's RPC spans counted from the press, ms
after the click (median, min–max):

| Request on the target node                                    | Before        | Final         | After the shell subscription, both arms |
| ------------------------------------------------------------- | ------------- | ------------- | --------------------------------------- |
| Shell subscription                                            | 647 (449–674) | 643 (449–668) | 0                                       |
| VCS status, thread windows, terminal and server subscriptions | 650–651       | 646–647       | 2–4                                     |
| Change requests list (3 of 15)                                | 715 (714–723) | 709 (709–710) | 260–263                                 |
| Project icon read (1 of 15 before, none final)                | 715           |               | 264                                     |
| Local tasks list and change subscription                      | 905 (711–941) | 902 (709–935) | 262–264                                 |
| Writable, for reference                                       | 838           | 838           | 195–200                                 |

- The early answer for observe-only reads changes nothing a switch does in the fixture: its
  one-shot reads still reach the node about 262 ms after the shell subscription, 60 ms after the
  thread is writable, in both arms. The local tasks and change request lists are not among the
  reads answered early, and the project icon read waits for the project list from the shell.
- The reads answered early (files and directory listings, local changes, history pages, diffs,
  config) are not issued by a switch in the fixture: its projects have no files and no repository.
  The git status reaches a cold switch as the VCS status subscription, which starts with the shell
  subscription in both arms (647 and 651 ms). The first file read on a cold switch could therefore
  not be measured here.
- Reads fetched again when the session becomes ready: none in either arm. No read reached the node
  before its session was ready, so none could be fetched a second time then. One read is fetched
  twice in every switch, cold or warm, in both arms: the local tasks list, the second time one
  browser-node round trip after the first (26–48 ms at D = 0, 164–170 ms at D = 40, 324–331 ms at
  D = 80). Follow-up: find what asks for it again once its first answer arrives.

### Relay drops

The relay-drop probe of "After wave 3": the tab first opens a thread on nodes 2 and 3, then 10
threads of node 1 in a row and the routed thread; restarting the delay proxy then drops every relay
connection at once, the nodes' included. Three drops 12–14 s apart per run, three runs per arm with
fresh node processes before every run, D = 0. ms after the drop, median (min–max), n = 3:

| Drop | Arm    | Writable again      | Node back on the Hub | Retry gap (writable − node back) | Client streams per drop |
| ---- | ------ | ------------------- | -------------------- | -------------------------------- | ----------------------- |
| 1st  | Before | 3,222 (1,304–3,505) | 1,051 (1,033–1,197)  | 2,025 (271–2,454)                | 1, 1, 1                 |
| 1st  | Final  | 1,908 (1,302–2,128) | 1,054 (996–1,114)    | 854 (306–1,014)                  | 1, 1, 1                 |
| 2nd  | Before | 3,937 (3,420–6,334) | 1,919 (1,887–2,299)  | 2,018 (1,121–4,447)              | 1, 1, 1                 |
| 2nd  | Final  | 2,672 (2,386–3,318) | 2,136 (1,800–2,319)  | 872 (250–999)                    | 1, 1, 1                 |
| 3rd  | Before | 7,063 (6,850–7,403) | 4,196 (3,528–4,743)  | 3,207 (2,320–3,322)              | 1, 1, 1                 |
| 3rd  | Final  | 5,485 (4,638–5,700) | 4,324 (3,469–4,418)  | 1,169 (1,161–1,282)              | 1, 1, 1                 |

- The demanded environment now retries once the directory reports its node online instead of
  waiting out its backoff: the retry gap falls from 2.0–3.2 s to 0.85–1.2 s at every drop, and
  never exceeds 1.3 s (it reached 4.4 s before). The nodes return as before (about 1, 2 and 4 s).
- What remains is the time until the directory reports the node again plus the reconnect itself,
  which takes 250–310 ms at best.
- Every drop still costs exactly one client stream in both arms: only the demanded environment
  reconnects, and the warm environments without a view are released. The page stayed responsive
  (0.23–0.43 s of main-thread tasks during a recovery).

### Memory

One tab opens 100 listed threads of the 2,000-thread node in a row, then stays idle for 7 minutes,
as under "After wave 3". Two runs per arm. Bodies are counted in the store's message index of a
heap snapshot taken after the idle period; message arrays are arrays of message objects anywhere
in that snapshot.

| Metric                                               | Before                    | Final                     | Target                     | Result |
| ---------------------------------------------------- | ------------------------- | ------------------------- | -------------------------- | ------ |
| Web JS heap after 1 / 32 / 64 / 100 threads (MiB)    | 31.9 / 41.7 / 45.7 / 49.4 | 31.6 / 41.7 / 45.7 / 49.5 |                            |        |
| Web JS heap after 7 minutes idle (MiB)               | 47.7–47.8                 | 47.7–47.8                 |                            |        |
| Thread bodies in the store after 7 minutes idle      | 64 in both runs           | 64 in both runs           | at most 64, plus protected | met    |
| Opened threads whose body was evicted                | 61–62                     | 63                        |                            |        |
| Of those, with their message array still in the heap | all                       | all                       |                            |        |
| Of those arrays, held by a module-level memo         | none                      | none                      |                            |        |
| Document event listeners after the 100 threads       | 516                       | 516                       |                            |        |

- No evicted thread's message array is held by a module-level value in either arm: none is
  reachable through a module-level memo. Every one of them is still reachable, though, in both
  arms: after the 100 threads the document holds 500 event listeners from the transcript selection
  toolbar, 5 per opened thread, so each toolbar instance stays alive with its props, the chat
  view's callbacks of that thread's render and, through them, the thread's composed messages. The
  store has evicted those bodies, but their messages are not freed while the tab lives, which is
  why the heap after idle does not change between the arms.
- Follow-up: find why the toolbar's document listeners outlive the thread it was mounted for (it is
  keyed by thread and removes its listeners in its effect's cleanup). Freeing them would let an
  evicted body's messages go as well.

### Pressing a row of a node that is not connected

With node 4 online and a warm set of three, a press on a row of the node the tab released starts
that node's connection and re-renders the inbox before the release: the pressed row is replaced by
a new element, and rows can move under the pointer. With trusted mouse input (move, press, release
80 ms later), in 8 clicks per arm, every click on a released node's row (4 of 4 per arm) opened
another node's thread (3) or nothing (1), in both arms; every click on a connected node's row
opened its thread, and so did a second click on a row of the node whose first click had failed.
The earlier probe pressed and clicked in one task, before any re-render, so it could not see this.
This session's page probes click the row element that is in the document at click time, which
measures the switch the user meant; the row was replaced in about a third of the cold switches
(6 of 15 at D = 40) and in no warm one, in both arms. Follow-up: keep the pressed row's element
and position stable while its node starts connecting, and let `hosted-switch` report a replaced
row instead of timing out.

### Node

Node rows, measured per arm with that arm's node code (nodes 1–3 online, D = 0, 60 s windows).
"Wake-ups" are context switches of the node process, a proxy for timer wake-ups; the time after
the nodes and the Hub started is given per row.

| Row                                                             | Before         | Final          |
| --------------------------------------------------------------- | -------------- | -------------- |
| Node RSS, idle, no client                                       | 257–269 MiB    | 257–269 MiB    |
| Node wake-ups per second, idle, no client, from 40 s            | 1.67–2.18      | 2.54–2.77      |
| The same from 150 s                                             | 1.73–2.00      | 1.80–2.02      |
| The same from 270 s                                             | 7.2–7.6        | 7.3–8.0        |
| Node 1 with 10 idle subscriptions against node 2 without, per s | 3.75 and 2.26  | 3.67 and 1.75  |
| RSS of the node holding the 10 subscriptions                    | 301 MiB        | 298 MiB        |
| Web JS heap after visiting three nodes, then after 10 switches  | 80.4, 98.9 MiB | 80.5, 99.0 MiB |
| `bun dev` peak RSS (process tree, 150 s, no browser)            | 1,027 MiB      | 1,023 MiB      |

- Idle, the two arms wake as often from 150 s on (1.7–2.0 per second); the first window after the
  start differs by less than one wake-up per second, and between about 4.5 and 5.5 minutes after
  the start every node of both arms wakes 7–8 times per second while its RSS drops by up to 9 MiB,
  so some scheduled work runs then in both (not traced here). The earlier session's 1.3 was
  measured later than these windows.
- The 10 subscriptions add 0.15–0.19 wake-ups per subscription per second in both arms, consistent
  with keepalive traffic on the open channel rather than timers.
- The heap after 10 switches is measured on three warm nodes (each switch opens a thread not shown
  yet); the base commit's 89.1 MiB was measured with two nodes and is not comparable.
- `bun dev`: with the web dev server's dependency cache in place. The first start of a fresh
  home peaks at 2,373 (before) and 2,388 MiB (final) while the dev server pre-bundles its
  dependencies, once.

### Desktop and mobile

Not measured on native clients: the local fixture cannot sign one in, so the native rows stay
manual production checks (see "Production (manual)"). The mobile directory now polls only while a
screen shows node presence, with a two-minute backstop otherwise; its polls per hour on a device are
one of those checks.

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

The wave-3 tip, on the same kind of fixture (see "After wave 3": the node rows under "Node", the
web rows under "Memory"), and this program's final tip (see "After waves 4 and 5 (final)"):

| Metric                                                               | Base commit          | After wave 0             | After wave 3                        | Final                       | Target                      | Result                     |
| -------------------------------------------------------------------- | -------------------- | ------------------------ | ----------------------------------- | --------------------------- | --------------------------- | -------------------------- |
| Node RSS, idle, no client                                            | 269–277 MiB          | 275–279 MiB              | 260–291 MiB                         | 257–269 MiB                 |                             |                            |
| Node wake-ups per second, idle, no client                            | 4.5–4.7              | 1.8–1.9                  | 1.3                                 | 1.7–2.0 from 150 s          |                             |                            |
| Wake-ups per idle subscription per second (10 subscriptions open)    | 10.0                 | 0.26                     | 0.06                                | 0.19 (0.15 before)          | no recurring timer wake-ups | met                        |
| `bun dev` peak RSS (process tree, 150 s, no browser)                 | 2,646 MiB            | 1,024 MiB                | 1,016 MiB                           | 1,023 MiB                   | -1.4 GB                     | met (-1,623 MiB)           |
| Codex status probe process starts while the reader lives             | 1                    | 1                        | not exercised (providers disabled)  | not measured again          | 0                           | not exercised              |
| `ps` spawns per minute with one idle terminal                        | 12                   | 12, then 2               | 13 in the first idle minute, then 2 | not measured again          | at most 2                   | met after the first minute |
| Web JS heap after 10 cross-node switches                             | 89.1 MiB (two nodes) | 81.0 MiB (two nodes)     |                                     | 99.0 MiB (three warm nodes) |                             |                            |
| Web JS heap after opening 100 threads of the 2,000-thread node       |                      | 98.9 MiB                 | 49.4 MiB                            | 49.4–49.5 MiB               |                             |                            |
| The same after 7 minutes idle                                        |                      | 98.7–98.9 MiB            | 47.7–47.8 MiB                       | 47.7–47.8 MiB               |                             |                            |
| Thread bodies in the store after 7 minutes idle                      |                      | every body (no eviction) | 64                                  | 64                          | at most 64, plus protected  | met                        |
| Long tasks per minute while a warm node out of view streams          |                      |                          | 0                                   | not measured again          |                             |                            |
| JSON stringify or parse of the metadata cache on a message-only tick | every tick           |                          | none (the change's tests)           | not measured again          | none                        | met in the tests           |

- `bun dev`: 1,016 (wave-3 tip) and 1,023 MiB (final) with the web dev server's dependency cache in
  place, as in the earlier measurement. The first start of a fresh checkout peaks at 2,378–2,388
  MiB while the dev server pre-bundles its dependencies, once.
- The final column's wake-ups and heap rows are the same in this session's before arm (see "After
  waves 4 and 5 (final)" → "Node" and "Memory"); its heap after 10 switches keeps three nodes warm
  and is not comparable with the two-node rows.
- The metadata tick is not measured on the fixture. Its tests pass at the wave-3 tip (20 in the
  metadata cache and projection suites), including a message-only store tick that keeps the arrays
  and does no JSON work, and a refreshed record whose arrays are not validated again.

## Production (manual)

The local fixture cannot measure a production Hub or sign in a native client. To compare production
with the local numbers above, the owner runs the same probes from a public checkout against their
own Hub; nothing needs to be built or deployed for it:

1. Sign in to the Hub in a browser and save that session as a cookie file (JSON with `cookieName`
   and `cookieValue`, see [Performance Testing](./performance-testing.md#commands)). Keep the file
   outside the repository and delete it afterwards.
2. Warm switch: with at most three nodes online (or visit only three), run
   `bun scripts/perf/cli.ts hosted-switch --hub-url <hub> --cookie-file <file> --iterations 8 --output <dir>/warm`.
3. Cold switch: with a fourth node online, run the same command with `--output <dir>/cold`. The
   probe picks the next node in the inbox's order, which can keep returning to nodes the tab still
   holds: a warm switch is writable within about 200 ms plus the delay, so read the slower switches
   as the cold ones. `hosted-correlate` can tell them apart exactly, but it needs the home
   directories of the target nodes (it reads their trace files, `--node-dir`) and, for the Hub
   side, a JSON-lines Hub log (`--hub-log`); use it only where both are at hand. A cold switch can
   also time out: the press on a row of a node the tab is not connected to can replace that row
   before the click (see "Pressing a row of a node that is not connected"). Such a timeout is a
   cold switch that a pointer's click would have missed as well, not a slow one.
4. Cold load: `bun scripts/perf/cli.ts hosted-cold-load --hub-url <hub> --cookie-file <file> --iterations 10 --output <dir>/load`,
   once more with `--visited`.
5. Check each result with `hosted-compare --baseline <file> --candidate <file> --targets <targets>`,
   with targets taken from the local numbers in "Against the targets" (for example
   `{"cross-node.writable": 250}` for the warm switch); use an earlier production result as the
   baseline, or the same file for both on the first run. Production adds the real network delay:
   read a result against the local row with the closest delay, using the `12·D + 600` budget for
   cold switches.

Native checks, by hand:

- Desktop: Cmd-Tab away and back several times with a hosted node open. Expect no new relay
  connection and the thread writable at once.
- Desktop: quit and start the app, then open a remote node cold; note the time to a writable thread.
- Mobile: with two nodes open, switch between them. Expect no network request and a writable thread
  at once.
- Mobile: force-quit and start the app; note the time to the first cached thread content, then to
  live content.
- Mobile: stay on a thread, with no screen showing node presence, for 10 minutes and count the node
  directory requests; expect about one every two minutes there, and one every 20 seconds while the
  home or connections screen is in front (when the account subscription is not live).
