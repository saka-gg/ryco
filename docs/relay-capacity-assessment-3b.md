# Wave 3b relay capacity assessment

- Date: 2026-08-21
- Assessment revision: `e4c4d214f`
- Scope: the proposed Wave 3b bound of two or three concurrent hosted connections per client

## Verdict

**The Wave 3b bound fits the documented relay budgets, with conditions.** A hosted environment
adds one relay client connection and one channel. It does not add a node connection: each online
node already owns one outbound relay connection and multiplexes up to eight channels over it.
Two or three idle hosted connections reserve no 8 MiB queues merely by existing, use at most 0.59%
of the 512 client-connection/channel limit per client, and consume 10% or 15% of the 20-token
upgrade burst bucket for that client's external peer address.

The capacity gate is discharged for a named bound of **three** only if Wave 3b keeps the mitigations
in its plan:

1. scope leases land before the bound is raised;
2. only mounted work acquires a connection, and unretained connections are released in background;
3. foreground reconnects are staggered rather than all attempted at once;
4. the five-node fixture asserts the bound and release behavior; and
5. connection acquisition never starts unrelated high-volume work.

This is not a claim that every combination of 512 admitted channels can simultaneously hold its
per-connection hard queue maximum. The 256 MiB process budget is deliberately smaller than the sum
of all possible 8 MiB connection maxima. It applies backpressure and closes a slow consumer before
that sum is reached. Fully saturated bidirectional queues cease to fit at 17 channels when every
channel targets a different node, or at 29 channels when channels are packed eight per node. That
is a slow-consumer saturation boundary, not an idle-connection boundary.

The residual risk is synchronized reconnect churn from several clients behind one NAT, plus real
traffic on the retained channels. The hosted screenshot fallback is the concrete traffic risk in
the next public pin: measured local PNGs would consume the 50 MiB per-channel transfer budget in
about 18 phone frames or 10 tablet frames. It is substantially heavier than Wave 3b's idle
connection cost and needs its own transfer-budget/product treatment; it does not justify keeping
3b gated on an unrelated production recovery drill.

## Inputs and accounting model

The Hub defaults assessed here are:

| Budget                          |                           Default | What Wave 3b consumes                                                  |
| ------------------------------- | --------------------------------: | ---------------------------------------------------------------------- |
| Relay upgrade burst             | 20 tokens, refilling at 1 token/s | one token per WebSocket upgrade                                        |
| Client connections              |                               512 | one per active hosted environment                                      |
| Node connections                |                               256 | no incremental connection; the enrolled node connection already exists |
| Global channels                 |                               512 | one per active hosted environment                                      |
| Channels per node               |                                 8 | one on each target node                                                |
| Per-connection queue hard limit |                             8 MiB | actual queued/native-buffered bytes, not a reservation                 |
| Aggregate queue budget          |                           256 MiB | actual queued/native-buffered bytes across the process                 |
| Per-channel transfer budget     |                            50 MiB | data-payload bytes in both directions for the channel lifetime         |

The upgrade bucket is keyed by the socket peer address. It is therefore **per external peer**, not
one global 20-token bucket. Clients on separate networks do not compete for it; clients behind one
NAT do. Existing upgrades or reconnecting nodes behind that same address consume some of the burst
headroom.

Let:

- `P` be the number of simultaneously foregrounded clients behind one external peer address;
- `C` be the bound per client, either 2 or 3;
- `A = P × C` be active client connections and channels; and
- `M` be the number of distinct target nodes.

Then Wave 3b's direct cost is:

```text
upgrade burst                         = P × C tokens per peer address
client connections and channels       = A = P × C
incremental node connections           = 0
maximum bidirectional hard-queue sum   = 8 MiB × (A + M)
```

The last line is an adversarial ceiling in which every client-side destination queue and every
target-node destination queue is simultaneously at its hard maximum. It is not memory reserved by
the connections. Since one node admits at most eight channels and one client does not connect to
the same node twice, the most tightly packed topology has
`M = max(C, ceil(A / 8))`. The most dispersed topology has `M = A`.

## Per-client cost

| Bound | Upgrade burst |  Client slots | Global channels | Fully queued ceiling across distinct target nodes |
| ----: | ------------: | ------------: | --------------: | ------------------------------------------------: |
|     2 |    2/20 = 10% | 2/512 = 0.39% |   2/512 = 0.39% |          `8 MiB × (2 clients + 2 nodes) = 32 MiB` |
|     3 |    3/20 = 15% | 3/512 = 0.59% |   3/512 = 0.59% |          `8 MiB × (3 clients + 3 nodes) = 48 MiB` |

At idle, the queue term is approximately zero. Queue ownership is acquired only when a frame is
enqueued and is released after native buffering drains or the connection closes.

## Plausible private-alpha populations

Five testers is a plausible early cohort. Eight is the useful upper scenario because eight
simultaneous channels to one node is itself the documented per-node limit. Ten shows the first
meaningful burst/queue boundary. The queue column assumes channels are packed onto the fewest nodes
allowed by the eight-channel per-node limit; the dispersed case is addressed below.

| Clients `P` | Bound `C` | Active channels `A` | One-peer burst | Global channel use | Minimum nodes `M` | All queues at hard max |
| ----------: | --------: | ------------------: | -------------: | -----------------: | ----------------: | ---------------------: |
|           5 |         2 |                  10 |    10/20 = 50% |     10/512 = 1.95% |                 2 |         96 MiB = 37.5% |
|           5 |         3 |                  15 |    15/20 = 75% |     15/512 = 2.93% |                 3 |       144 MiB = 56.25% |
|           8 |         2 |                  16 |    16/20 = 80% |     16/512 = 3.13% |                 2 |       144 MiB = 56.25% |
|           8 |         3 |                  24 |   24/20 = 120% |     24/512 = 4.69% |                 3 |       216 MiB = 84.38% |
|          10 |         2 |                  20 |   20/20 = 100% |     20/512 = 3.91% |                 3 |       184 MiB = 71.88% |
|          10 |         3 |                  30 |   30/20 = 150% |     30/512 = 5.86% |                 4 |      272 MiB = 106.25% |

The one-peer burst column is intentionally pessimistic: every client shares one NAT, starts from a
full bucket, and upgrades at the same instant. With separate peer addresses, each client consumes
only 2 or 3 of its own 20 tokens. When one peer does exceed the bucket, the earliest possible tail
is one additional upgrade per second: a 24-upgrade burst needs at least four seconds for the last
four tokens, and a 30-upgrade burst needs at least ten seconds. Wave 3b already requires staggered
foreground wake-up; that requirement is what keeps this boundary from becoming a reconnect storm.

The exact stop points are:

- per peer address, 10 clients at a bound of 2 fill the burst bucket and client 11 exceeds it;
  6 clients at a bound of 3 use 18 tokens and client 7 reaches 21 and exceeds it;
- the ninth simultaneous channel to one node exceeds the per-node channel limit;
- globally, 256 clients at a bound of 2 fill 512 client/channel slots; at a bound of 3, 170 clients
  use 510 and client 171 reaches 513;
- with every destination queue simultaneously at 8 MiB and nodes packed as tightly as allowed,
  14 two-connection clients reach exactly 256 MiB and client 15 exceeds it; 9 three-connection
  clients reach 248 MiB and client 10 exceeds it; and
- with one distinct target node per channel, 16 channels reach exactly 256 MiB, so the 17th ceases
  to fit. That is 8 two-connection clients versus 9, or 5 three-connection clients versus 6.

The queue stop points do not mean the corresponding connection should be rejected at admission.
The process does not pre-reserve 8 MiB per connection. They mean that a simultaneous, bidirectional,
all-slow-consumer scenario cannot grant every connection its local maximum; the process-wide
reservation fails closed first, as designed. These arithmetic boundaries assume no unrelated queue
ownership, so real headroom is smaller whenever other relay traffic is already buffered.

## What scope leases change

Without leases, a naive multi-connect implementation can retain `P × C` connections until process
exit, including nodes with no mounted consumer. Scope leases do not lower Wave 3b's hard foreground
maximum by themselves: the plan defines lifetime as retained scopes **plus LRU recency**, still
bounded by `C`. A warmed foreground client may therefore keep all `C` slots in both designs.

What leases change is the non-evictable set and the background/reconnect floor. After background
release removes non-retained LRU entries, the live count is:

```text
post-release connections = sum over clients(min(C, distinct environments with retained scopes))
```

For eight clients that have each touched the full bound, then background with one retained
environment each:

| State                                       |  Bound 2 |  Bound 3 |
| ------------------------------------------- | -------: | -------: |
| Warm foreground maximum, leased or unleased |       16 |       24 |
| Naive unleased background/reconnect set     |       16 |       24 |
| Leased post-release retained set            |        8 |        8 |
| Background/reconnect reduction              |      50% |    66.7% |
| One-peer reconnect burst after release      | 8 tokens | 8 tokens |

At the bound of 3, background release plus leases turn the eight-client shared-NAT reconnect case
from an over-capacity 24-upgrade burst into an 8-upgrade burst. If there is no retained mounted
scope after backgrounding, the retained contribution is zero. Foregrounding must reconnect only
the retained set and stagger those attempts; reconnecting the LRU/catalog eagerly would erase the
mitigation. While foregrounded, LRU recency may fill the remaining slots again as the user opens
work, but it does so on demand rather than as one synchronized wake-up.

Wave 3b's mobile scopes do not own the web simulator preview, so leases do not reduce the existing
web screenshot fallback and must not be counted as if they did. The general invariant is still
important: merely retaining a cached environment connection must not start unrelated high-volume
work. The web fallback's mounted-panel lifecycle needs separate review with the pin.

## Measured staging observation

The existing chunk performance scripts are not network harnesses. They intentionally measure only
`prepareRelayMessage` plus `RelayMessageAssembler` in one process; they open no socket and cannot
observe connection counts, upgrade buckets, Hub queue bytes, file descriptors, RSS, or event-loop
delay. Extending their output to claim any of those would violate the scripts' stated scope.

A bounded staging observation used two already-running, enrolled local QA nodes and ordinary hosted
client connections. No production endpoint or configuration was touched.

1. Before a client opened a node, each local connector reported `activeChannels: 0` and
   `queuedBytes: 56` while retaining exactly one established outbound TLS socket.
2. One hosted client produced `activeChannels: 1` and `queuedBytes: 121` on its target node. The
   other node remained at zero channels; neither node gained another TLS socket.
3. Two visible hosted clients targeting the two nodes concurrently produced one active channel on
   each node. Three samples over 22 seconds held both at one channel; the reported outbound queues
   stayed between 56 and 121 bytes.
4. Hiding the first client released its channel. This is consistent with the lifecycle behavior
   Wave 3b's scope leases are meant to preserve.

The repeatable read-only observation seam is the bounded local status command:

```sh
node apps/server/dist/bin.mjs hub status \
  --base-dir <qa-node-base-dir> \
  --dev-url <qa-dev-url> \
  --json
```

Expected shape while one hosted client is open:

```json
{
  "state": "online",
  "protocolMajor": 1,
  "protocolMinor": 2,
  "activeChannels": 1,
  "queuedBytes": 121
}
```

The exact small queue value varies with heartbeat/control timing. This status is the node
connector's bounded local observation, not the Hub process queue metric. The staging Hub's
aggregate queue, RSS, file descriptors, event-loop delay, and client-side queue could not be
determined without authenticated aggregate metrics; no metrics credential was opened or read for
this assessment.

## Hosted screenshot fallback

The next public pin includes a hosted simulator fallback that requests a full PNG, returned as a
base64 JSON field, and schedules the next request 750 ms **after the previous request completes**.
The theoretical upper sampling rate is therefore 1.333 frames/s; real throughput is lower by the
capture, RPC, relay, decode, and paint latency.

Five direct local captures of each already-booted QA simulator produced identical sizes for their
static screens:

| Device class      | PNG bytes | Base64 bytes | Relay chunks (minimum) | Chunk payload bytes (minimum) | Share of one 8 MiB queue | Max rate at 750 ms |
| ----------------- | --------: | -----------: | ---------------------: | ----------------------------: | -----------------------: | -----------------: |
| Phone, 1206×2622  | 2,289,823 |    3,053,100 |                     12 |                     3,053,196 |                   36.40% |         3.88 MiB/s |
| Tablet, 1668×2420 | 4,177,412 |    5,569,884 |                     22 |                     5,570,060 |                   66.40% |         7.08 MiB/s |

The chunk calculation uses the real 256 KiB data-chunk maximum and 8-byte chunk header. It is a
lower bound because it includes the base64 field but excludes the rest of the JSON RPC response,
outer relay-frame encoding, WebSocket reserve, request traffic, and (when negotiated) the 32-byte
E2EE record overhead.

The 50 MiB transfer limit counts data payloads in both directions. Ignoring the smaller request
direction and all omitted overhead gives the most favorable possible result:

```text
phone:  52,428,800 / 3,053,196 = 17 complete frames; frame 18 exceeds the budget
tablet: 52,428,800 / 5,570,060 =  9 complete frames; frame 10 exceeds the budget
```

At the theoretical 750 ms upper rate, those payloads consume 50 MiB in 12.88 seconds and 7.06
seconds respectively. Actual closure takes longer because the timer starts after each request, but
the number of frames does not improve; JSON/request/E2EE overhead makes it slightly worse. A healthy
consumer therefore reaches `transfer_limit` after seconds to tens of seconds, without any slow
consumer or queue saturation.

One in-flight measured tablet response is about 2.08% of the 256 MiB aggregate queue budget if it
has to queue in full; one phone response is about 1.14%. Those are much larger than the observed
tens of idle control bytes. The screenshot path is therefore the more important sustained-load
finding in the next pin. It needs a separate decision such as a lossy/binary stream, a lower or
adaptive cadence, delta frames, or an explicitly bounded preview session. Raising the transfer
budget alone would not address bandwidth or slow-consumer pressure.

## Capacity gate for implementation and review

Wave 3b may be built and reviewed against this gate:

- define the maximum as a named constant no greater than 3;
- land and test scope leases before raising the maximum;
- acquire only on a user opening work in an environment;
- release non-retained connections on background and do not eagerly reacquire the catalog;
- stagger reconnects so one peer address does not issue more than 20 upgrades in a burst;
- assert at most 3 active hosted connections under a five-node fixture;
- assert acquiring or retaining a connection does not start unrelated high-volume work; and
- record connection count, active scopes, reconnect attempts, and aggregate queue metrics during
  staging QA without payloads or high-cardinality identifiers.

Passing those checks discharges the concurrency risk that was previously represented by the Hub
rollout-drill gate. Production recovery qualification remains valuable for release operations, but
it measures a different risk and is not a prerequisite for the bounded client-side change.

## Wave 4 hosted-Web qualification

Hosted Web deliberately started below the native ceiling. Its named maximum was one because the
browser can add a sustained full-PNG preview to the ordinary thread, VCS, and provider streams. The
warm set qualification below raised it to three; this section is kept as the record of the
one-connection bound it replaced.
The adaptive sampler uses the measured base64 payload, schedules only after completion, retains the
750 ms floor, and suspends when either the document or preview is hidden.

For the measured 3,053,100-byte phone frame, the deterministic qualification calculation is:

| Retained environments | Active Web connections | Queued demand | Effective PNG interval | Screenshot bytes/s per visible stream | Counterfactual unbounded aggregate |
| --------------------: | ---------------------: | ------------: | ---------------------: | ------------------------------------: | ---------------------------------: |
|                     1 |                      1 |             0 |               5,824 ms |                               524,228 |                            524,228 |
|                     2 |                      1 |             1 |               5,824 ms |                               524,228 |                          1,048,456 |
|                     3 |                      1 |             2 |               5,824 ms |                               524,228 |                          1,572,684 |

The two- and three-stream aggregates are counterfactual load calculations, not approved Web
bounds: the platform ceiling prevents them. Thread/VCS/provider payload rates were not available
from a public aggregate metric, so they are not silently treated as zero. An unleased catalog
starts zero relay streams and zero connections; mounted thread detail, VCS, and provider scopes
are refcounted and are the only inputs that can acquire an environment. Under the five-node fixture
one environment connects and four wait. Backgrounding releases non-retained LRU connections;
foregrounding restores only retained demand, so the one-connection Web bound produces at most one
reconnect attempt and cannot form a reconnect storm. Raising the bound requires measured aggregate
scope traffic in the same change.

## Hosted Web warm set qualification (measured)

Hosted Web now keeps a warm set of up to three environments per tab, the unified ceiling. The
change that raised the bound records its qualification here, measured on a local full-stack fixture
(a Hub, enrolled nodes and headless browser contexts on one machine, with no added network delay
unless stated) with the previous bound of one and the new bound of three, in interleaved blocks.
Each cell pools at least seven samples per bound (switches, wakes, restarts, heap runs or tabs),
except the node ladder, which sampled two nodes at four channel counts twice per bound. Values are
medians with the range in parentheses. Numbers are local aggregates; they carry no hostnames, URLs,
node or account identifiers, logs or raw traces.

The bound stays within the gate above: it is a named constant no greater than three, the demand
state refuses a larger platform ceiling, the five-node test asserts that at most three hosted
connections exist at any time, and only scopes (a mounted view, a queued send, home discovery, a
short navigation-press intent) acquire an environment. The full-PNG fallback stays bounded by the
one device preview a tab may sample at a time.

Only demanded environments reconnect on their own. After a Hub session loss — a deploy, a restart,
an interruption at a proxy — a warm environment that nothing demands is released and reconnects
when it is demanded again, so the reconnect burst after a Hub restart is the number of demanded
environments across tabs, not three per tab. This holds whether or not any Hub-side rate-limit
change is deployed.

| Check                                        | Target                                                                                                 | Bound of one                                                                                    | Bound of three                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Traffic per warm environment                 | Idle warm stream bytes/s and streaming bytes/s per environment                                         | 52 B/s per tab idle on its one connection; nothing from machines out of view                    | +58 B/s idle per extra warm environment; +2.9 KB/s while one of them streams                                         |
| Two visible previews under the preview lease | No `transfer_limit` close in 10 minutes                                                                | Not measured: no device preview source on the fixture                                           | Not measured: no device preview source on the fixture                                                                |
| Browser memory and long tasks                | JS heap at three environments within 1.5× of one, with 1,000 and 4,500 threads                         | 213 and 803 MiB after three machines                                                            | 209 and 803 MiB (0.98× and 1.00× of the bound of one); 7.5× and 27× of one machine in both bounds: missed as written |
| Node cost per extra channel                  | Node RSS and CPU per additional channel                                                                | 0.02 MiB RSS (at most 1.3 MiB) and about 0.015% of one core per idle channel                    | The same per channel                                                                                                 |
| Wake and Hub restart, up to 8 contexts       | No `rate_limited` loop; reconnects after the restart limited to demanded environments                  | No rate limiting; one ticket and one stream per tab per wake or restart                         | No rate limiting; one ticket and one stream per tab; a restart turned 24 warm streams into 8: met                    |
| Warm switch                                  | Click task ≤150 ms, content ≤200 ms, writable ≤250 ms (±10%); no new Hub stream, no node shell request | Click 197 ms, content 352 ms, writable 356 ms; a Hub stream and a node shell request per switch | Click 132 ms, content 158 ms, writable 158 ms; no Hub stream, no node shell request: met                             |
| Four simultaneous foreground wakes           | At most 8 slots per node, no retry storm, node handshake bucket (8 burst, 2/s) not exhausted           | At most 2 channels per node, one ticket per tab, at most 2 opens per node in any second         | At most 4 channels per node (2 after the wake), one ticket per tab, at most 2 opens per node in any second: met      |

The switch, reconnect and wake targets are met. The memory target is missed as written, for a
reason that does not depend on the bound (below). The preview check and native wakes remain manual
checks.

Results:

- **Traffic.** Seven tabs per block, two blocks per bound, each opened a thread on three machines in
  turn and stayed on the last. With the bound of one a tab carried 52 B/s (45–56) while idle, sent
  and received together, on its one connection. With the bound of three it carried 168 B/s
  (160–184), about 58 B/s for each of the two extra warm environments. While a thread on a warm
  machine out of view received a message every two seconds, each tab carried 3.0 KB/s (3.02–3.03),
  about 2.9 KB/s for that environment's live updates; with the bound of one the tab was not
  connected to that machine and stayed at 52 B/s.
- **Previews.** Not measured. The fixture nodes have no device preview source (a preview needs a
  simulator attached through the node's device helper), so the ten-minute check remains a manual
  check against a Hub with a device-capable node. The warm set adds no preview traffic by
  construction: a tab samples at most one device preview at a time, so a second visible preview
  pauses instead of opening a second full-PNG stream, as the preview lease tests assert.
- **Browser memory and long tasks.** One tab opened a thread on three machines in turn, eight runs
  per bound and size, with 333 threads per machine (1,000 in all) and 1,500 per machine (4,500 in
  all). The JS heap after garbage collection, after the first, second and third machine, was 28.6,
  121 and 213 MiB, and 29.3, 406 and 803 MiB, with the bound of one; 27.9, 119 and 209 MiB, and
  29.5, 406 and 803 MiB, with the bound of three. The warm connections add no measurable heap: after
  the same three machines the bound of three holds 0.98× and 1.00× of the bound of one. The target
  as written, three environments within 1.5× of one, is missed in both bounds (7.4–7.5× and 27×):
  the inbox keeps and renders the thread rows of every machine the tab has left, at about
  0.25–0.28 MiB of heap per row on this fixture, and the first point has no rows yet. That row cost
  is independent of the bound. The switch to the third machine ran a long task of about 0.6 s with
  1,000 threads and 3.9–4.1 s in all with 4,500 threads in both bounds; an idle tab ran no long
  tasks in either bound.
- **Node cost.** A ladder added browser contexts until two nodes each held 0, 2, 4 and 6 channels.
  Node RSS grew by 0.02 MiB per channel (median; at most 1.3 MiB), inside the drift of a node
  without channels over the same windows (up to 3 MiB). Idle CPU stayed at about 0.1% of one core
  with six channels, about 0.015% per channel. The per-channel cost is the same in both bounds; the
  bound of three places one channel on each of up to three nodes per tab.
- **Wake and Hub restart.** Eight tabs, each in view on one of three machines and, with the bound of
  three, warm on the other two, went offline for 10 seconds four times and then saw four Hub
  restarts, in two blocks per bound; three more restarts per bound hit tabs that still held their
  full warm sets. Every wake cost one ticket and one stream per tab in both bounds; with the bound of
  three the first wake closed all 24 warm streams and reopened only the 8 in view. Tabs were writable
  again 0.50 s (0.39–0.62) after the wake with the bound of one and 0.45 s (0.23–1.39) with the
  bound of three. After every restart each tab
  opened exactly one stream, also when the tabs held 24 warm streams before it. Ticket requests for
  a node that had not yet re-registered were refused as offline and retried (2–12 refusals per
  restart for eight tabs), so tabs were writable again in two clusters, around 2.7 s and 6 s after
  the Hub was ready: 2.9 s (0.4–7.1) with the bound of one and 4.0 s (1.0–11.0) with the bound of
  three, the median moving with the share of tabs in the later cluster. The longest case followed a
  restart that took 5 seconds under load. No request was rejected for a rate limit in either bound,
  and no node saw more than three channel opens in any second.
- **Switch.** The switch probe alternated between threads on two of three machines, 16 measured
  switches per bound and delay; with the bound of three every switch went to a warm environment.
  With the bound of one: click task 197 ms (186–207), content 352 ms (209–403), writable 356 ms
  (330–403), and every switch opened a Hub stream and a node shell subscription. With the bound of
  three: click task 132 ms (118–145), content and writable 158 ms (140–169), and no switch opened a
  Hub stream, issued a ticket or reached a node's shell subscription. Switching back to a thread
  opened before took 127 ms (108–151) to the click and 150 ms (140–175) to content and writable.
  With 40 ms added in each direction, a warm switch to a thread not yet opened took 289 ms (138–299)
  to content, one node round trip for its messages, against 829 ms with the bound of one. A true
  cold switch, cycling four machines so that the bound of three always returns to its released,
  least recently used environment, took 235, 254 and 385 ms (click, content, writable) with the
  bound of one and 203, 236 and 357 ms with the bound of three when a stream had to open (18 of 24
  switches; the other six still found the environment warm): not slower.
- **Four simultaneous wakes.** Two tabs of one context and two more contexts, each in view on its
  own machine and, with the bound of three, warm on the others, went offline together four times
  per block. Before a wake each node carried at most 2 channels with the bound of one and 4 with the
  bound of three; after it at most 2 in both. Every wake cost exactly one ticket per tab, no node saw
  more than 2 channel opens in any second against a handshake burst of 8, and no request was
  rejected or retried.

Caveats:

- The Hub's peer-keyed rate buckets are shared by every client behind one address. Behind a
  terminating proxy that is every client of the deployment, so the fixture's per-machine numbers are
  a lower bound for what a proxy-fronted Hub sees after a restart.
- Eight tabs whose warm sets cover the same machine hold eight channels on it, the per-node channel
  limit. More tabs warm on one machine were not measured.
- The four simultaneous wakes are browser contexts (two tabs of one context and two more contexts
  standing in for other devices). Native Desktop and Mobile wakes cannot be measured on the local
  fixture, because native sign-in needs an https origin and a native identity; they remain a manual
  check against a production Hub.
