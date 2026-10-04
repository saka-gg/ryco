# Outbound Hub connector

Ryco can maintain one authenticated outbound WebSocket to a configured Hub. This lets a server
behind NAT or CGNAT receive authorized logical `ryco.rpc` channels without opening another inbound
listener. Direct LAN, desktop-local, SSH-assisted, and Tailscale access continue to use the existing
server listener and are independent of the connector.

The connector consumes relay protocol 1.2 and negotiates 1.3 when the Hub supports account-enrolled
native E2EE. It does not provide a generic tunnel and does not move
projects, files, terminals, conversations, provider sessions, orchestration state, attachments, or
payload persistence into Hub. The Ryco node remains authoritative for all application state.

## Configuration

The connector is disabled by default. Configure it through the server process environment:

| Variable                           | Default | Valid range or meaning                                |
| ---------------------------------- | ------- | ----------------------------------------------------- |
| `RYCO_HUB_CONNECTOR_ENABLED`       | `false` | Exact `true` or `false`                               |
| `RYCO_HUB_ORIGIN`                  | unset   | Exact HTTPS origin; loopback HTTP is development-only |
| `RYCO_HUB_NODE_NAME`               | unset   | Proposed enrollment label; trimmed, 1–100 characters  |
| `RYCO_HUB_RECONNECT_BASE_MS`       | `1000`  | 250–60,000 ms                                         |
| `RYCO_HUB_RECONNECT_MAX_MS`        | `60000` | 250–300,000 ms and not below the base                 |
| `RYCO_HUB_RECONNECT_STABLE_MS`     | `60000` | 5,000–600,000 ms                                      |
| `RYCO_HUB_RECONNECT_JITTER_RATIO`  | `0.2`   | 0–0.5                                                 |
| `RYCO_HUB_ALLOW_FILE_SECRET_STORE` | `false` | Explicit POSIX permissioned-file fallback             |

The four ordinary startup settings also have shared server CLI flags:

| CLI flag                                  | Environment fallback               |
| ----------------------------------------- | ---------------------------------- |
| `--hub-connector-enabled` (alias `--hub`) | `RYCO_HUB_CONNECTOR_ENABLED`       |
| `--hub-origin <origin>`                   | `RYCO_HUB_ORIGIN`                  |
| `--hub-node-name <name>`                  | `RYCO_HUB_NODE_NAME`               |
| `--hub-allow-file-secret-store`           | `RYCO_HUB_ALLOW_FILE_SECRET_STORE` |

Startup values resolve in this order: an explicit CLI flag, its corresponding environment variable,
the private desktop bootstrap envelope, then the default. A headless `ryco serve` process has no
desktop bootstrap envelope, so an omitted flag continues to fall back to the environment unchanged.
The boolean flags use standard presence syntax and support the canonical
`--no-hub-connector-enabled` and `--no-hub-allow-file-secret-store` forms for explicit `false`
overrides.

## Relay end-to-end encryption admission policy

One closed policy value governs which relay channels the node admits. It follows the same
flag → environment → bootstrap-envelope precedence and is defined normatively in
`docs/relay-e2ee-protocol.md` §18.8.

| CLI flag                   | Environment fallback   | Default         |
| -------------------------- | ---------------------- | --------------- |
| `--hub-e2ee-policy <mode>` | `RYCO_HUB_E2EE_POLICY` | `compatibility` |

The accepted modes are:

| Mode                                   | Legacy | Web NX | Account-enrolled native | Locally approved native |
| -------------------------------------- | ------ | ------ | ----------------------- | ----------------------- |
| `compatibility`                        | yes    | yes    | yes                     | yes                     |
| `require-e2ee`                         | no     | yes    | yes                     | yes                     |
| `require-native-e2ee`                  | no     | no     | yes                     | yes                     |
| `require-locally-approved-native-e2ee` | no     | no     | no                      | yes                     |

This is **durable node state, not per-process configuration**. A value given on a start is committed
to the node's policy record; leaving it unset later leaves the committed value unchanged. Moving to a
stricter mode is a policy withdrawal: before acknowledging it, the node commits the new value,
increments its policy generation, aborts newly disallowed handshakes, and closes newly disallowed live
channels. Widening affects only later channels.

The legacy `--hub-require-e2ee` / `RYCO_HUB_REQUIRE_E2EE` and
`--hub-require-approved-client-e2ee` / `RYCO_HUB_REQUIRE_APPROVED_CLIENT_E2EE` inputs remain migration
aliases. An explicit approved-client requirement maps to
`require-locally-approved-native-e2ee`; otherwise an explicit E2EE requirement maps to
`require-e2ee`; otherwise the v1 record maps to `compatibility`. Conflicting new and legacy inputs are
configuration errors. No old record maps implicitly to `require-native-e2ee`.

**`require-locally-approved-native-e2ee` disables Web, account enrollment, and legacy access.** If
every approved native key is lost, remote access is stranded until local recovery. Recovery never
relaxes policy.

### Capability advertisement

An E2EE-capable node tells clients so by advertising, never by being probed. On every relay channel
it accepts, the node emits one signed capability statement — its identity, agreement prekey
certificate, identity-continuity chain, suite registry, admission policy, policy generation, and a
bounded validity interval — as the **first** node-to-client payload, at relay data sequence 0,
through the same ordered send path as every other message. The carrier is a single reserved-tag
JSON object that existing clients demonstrably ignore, so a client that predates this protocol is
unaffected by it. Normative definition: `docs/relay-e2ee-protocol.md` §5.2–§5.5.

The statement is built and signed ahead of the channel, and it is rebuilt whenever anything it
carries changes — a policy change, a prekey rotation, an identity rotation, or the end of its
validity window. There is no way to advertise a stale one.

A node can fail to have an advertisement for a channel in exactly two ways, and neither is silent:

- **Undersized connection** — the relay asserted a `maxDataChunkBytes` too small to carry any
  conforming carrier. This is decided once per connection, from a value the relay operator chooses
  and neither endpoint can veto.
- **No conforming statement** — the node's own self-check failed: an over-long canonical Hub origin,
  a continuity chain past its bound, a refused signing call, or a continuity id the startup
  cross-check could not resolve.

Under any policy mode except `compatibility` either condition is fatal: the affected channels are closed
with the ordinary `channel_rejected` reason, indistinguishable on the wire from every other
pre-key rejection, and the node logs an operator diagnostic naming the condition — and, for an
undersized connection, both the asserted limit and the minimum this protocol needs. Otherwise the
node suppresses the advertisement, serves the channel as an ordinary legacy channel, and records
one occurrence in the **advertisement-unavailable** class of its fallback counters. That class is
counted and displayed separately from genuine legacy peers on purpose: "this node could not
advertise" is a fact about the node, and letting a relay-asserted chunk limit inflate the
legacy-peer count would let the relay operator hold the rollout open indefinitely.

The node keeps three further state files beside its identity state for this: the durable admission
policy record, the bounded fallback counters, and the approved-client records the encrypted
handshake checks. None of them holds channel, session, key, or payload data, and the client
records hold key fingerprints rather than keys. The policy record is the operator's own and
survives leaving a Hub; the client records are Hub-scoped and are erased with the enrollment.

### Capability publication and relay 1.3

On a relay 1.3 connector, the node publishes the exact signed capability statement to the Hub after
`ready`. Publication contains the exact statement bytes, their SHA-256 digest and expiry, and the
current connector generation. The node republishes after any identity, agreement-prekey,
continuity-chain, suite, policy, validity-window, or connector-generation change. Account-grant
admission remains disabled until the Hub acknowledges the exact digest in the same generation.

A statement the node cannot build — a credential store that is locked for a while, a prekey or
continuity read that fails — is withdrawn at once and retried in the same generation, 30 seconds
later and backing off to five minutes, instead of leaving account-grant channels refused until the
next reconnect. A republish that throws, usually because the send queue is momentarily full, is
also withdrawn and retried within seconds; only three consecutive failures rebuild the connection,
because rebuilding it closes every live channel to resend one control frame.

The authenticated connector also receives a bounded, generation-numbered Ed25519 Hub verification
keyset and enrollment-revocation events. These values remain in memory. Reconnect clears the statement
acknowledgement, keyset, ticket contexts, and subscriptions before a new generation may report ready.
Signing keys supplied only inside a ticket, grant, or channel frame are never trusted.

For an account-grant ticket the Hub's minor-3 `channel.open` adds one all-or-nothing context:

```text
[ 0x02, relayTicketId, bstr(deviceGrantDigest), bstr(nodeCapabilityStatementDigest) ]
```

The node requires the ticket id and both digests to match the decrypted grant and the exact statement
it advertised on that channel. The node retains the statement and matching prekey until their last
ticket/grant overlap expires. A missing snapshot, partial context, stale generation, or mismatched
digest is rejected before application data. Suite `0x01` and Web channels omit this context and remain
compatible with relay 1.2.

### What a channel does after the advertisement

Every accepted channel runs one receiver mode machine, created at `channel.accept` and destroyed
when the channel closes. It starts in `negotiating` and reaches exactly one of two settled modes,
one way only: `e2ee` through a complete authenticated handshake, or `legacy` when fallback policy
accepts the peer's first plaintext message. There is no mid-channel upgrade and no downgrade.
Normative definition: `docs/relay-e2ee-protocol.md` §4.3–§4.4, §8–§11.

Every inbound payload is classified **after** relay chunk reassembly and prelude stripping, never
on raw wire bytes, and what the class is allowed to be depends on the mode. The consequence worth
stating plainly is that on an `e2ee` channel the only route to the RPC parser is a successfully
authenticated encrypted record: a plaintext message arriving after encryption is established ends
the channel rather than being served. An unknown first byte — and an empty payload, which has none
— is fatal in every mode and is never treated as a harmless no-op.

Outbound, an RPC response on an `e2ee` channel is encrypted before it reaches the relay's chunking
layer, and **transmission admission for the whole record is obtained before the record's nonce is
assigned**. That ordering is not an optimization: a sender that encrypted first and rolled its
counter back when the send queue refused would reuse a nonce with different plaintext. A refused
send therefore consumes nothing, emits nothing, and leaves the channel usable — ordinary
backpressure, exactly as on a legacy channel.

Failures are deliberately uniform on the wire. Before session keys exist, every fatal condition
produces the same fixed-size rejection record and the same `channel_rejected` close reason,
whatever the cause was — an unknown client key, a signature failure, a policy refusal, or an owner
revocation landing mid-handshake are indistinguishable to whoever is on the other end. After keys
exist, it is one length-uniform encrypted error record and the same close reason. The node logs
which rule fired; the wire does not carry it. An orderly close is different from both: the two
ends exchange authenticated close records first, and only then does the channel close with no
reason at all.

The desktop app deliberately owns these four values for its bundled server. It persists them in
desktop settings, removes matching `RYCO_HUB_*` variables from the backend child environment, and
passes the values over the private bootstrap channel. This keeps the visible desktop controls
authoritative. The Hub card keeps the address and pre-enrollment node name visible and puts key
fallback, startup ownership, CLI equivalents, and bounded relay counters behind **Show advanced
options**. Changing a desktop launch value restarts Ryco; when agent turns are running on the
desktop's own backend, Ryco first asks whether to restart now, after they finish, or not at all. A
change deferred until they finish is saved at once and only the restart waits, so it still applies
on the next launch if Ryco quits, crashes, or updates first.

Until the operator turns the desktop connector on or off, a configured Hub launches it in
**standby**: the backend runs the connector only when its own state files show no Hub identity
(`resolveStandbyHubConnectorConfig`). An identity-less connector parks in `enrolling`, opens no
socket, and selects key custody without reading the credential store, so device-code enrollment
and native account sign-in complete in the running process instead of after an onboarding restart.
Any existing identity, which may have been switched off on purpose or may belong to another runner
sharing the state directory, resolves standby to disabled without opening key custody. An explicit
flag or environment value is never refined by standby, and a standby connector whose host cannot
open a key store stays off instead of reporting the key store failure. Standby is not consent to
join the Hub:
only the user's own account sign-in or device-code enrollment puts a standby node on the Hub, and
the background account resume at startup claims the node only for a connector the operator turned
on. Settings written before the choice was recorded keep a connector that is off beside a retained
account session off. An identity-less standby connector is not Hub-connected, so external Agent
Control integrations keep working beside it. If it gains an identity in the running process, the
server closes the external integration listener and its connections before the connector opens its
first relay connection; from then on external integrations stay unavailable until the connector is
turned off.

For example:

```bash
ryco serve \
  --hub-connector-enabled \
  --hub-origin https://hub.example.test \
  --hub-node-name "Build node" \
  --hub-allow-file-secret-store \
  --restrict-to-cwd \
  --host 127.0.0.1 \
  --port 3774 \
  --base-dir /path/to/node-state \
  /allowed/workspace
```

`--restrict-to-cwd` limits Ryco-managed browsing, project roots, clone destinations, terminal
starting directories, and generated worktrees to the final positional working directory. The
directory is resolved canonically at startup, and Ryco rejects direct traversal and symlink escapes.
The flag is optional and has no environment-variable fallback. If the existing node state contains
an active project or live worktree outside that root, restricted startup fails without changing the
persisted data; archive or remove the incompatible state in unrestricted mode, or select a fresh
`--base-dir`.

`--base-dir` remains the trusted location for node identity, database, logs, and other internal
state. It is not the accessible workspace root. This application-level restriction does not confine
commands after a terminal or coding-agent process starts: use a container or operating-system
sandbox when processes must be unable to read paths outside `/allowed/workspace`.

An invalid enabled configuration fails closed with `configuration_invalid`. When the connector is
enabled from the CLI or environment without an origin, it uses the hosted Hub at
`https://app.ryco.space`; enrollment still needs an owner's explicit approval there. Credentials,
keys, challenges, signatures, and polling secrets are never accepted through command-line
arguments, URLs, or exported server settings.

Enabling the connector starts no listener. It uses the existing Ryco HTTP server only for
authenticated local status and enrollment controls.

Connector state and identity state are reported separately, and the distinction matters: `disabled`
is reported both for a node that was never enrolled and for an enrolled node whose connector is
switched off. A caller that must not offer to re-point an already-enrolled node reads the bounded
identity summary — `none`, `pending`, `active`, or `unknown` — rather than inferring it from state.
`unknown` means key custody could not be read at all, and must be treated like `active`: refusing a
destructive action is the safe answer when an identity may exist.

### Operator commands

The encrypted relay layer's owner-facing state is reached through `ryco e2ee`, a sibling of
`ryco hub` rather than a subtree of it: `hub`'s subcommands are connector-lifecycle verbs, while
these are about node-owned security state that outlives any one connector. Every one of them
requires the running server, for the same reason the acknowledgements mean anything at all.

```bash
ryco e2ee client list                      # records, saturation, refusal count, pairing window
ryco e2ee client show <fingerprint>        # one record and its long-term safety number
ryco e2ee client approve <fingerprint> --max-role <role> --capability <capability>
ryco e2ee client narrow <fingerprint> [--max-role <role>] [--capability <capability>]
ryco e2ee client revoke <fingerprint>
ryco e2ee client purge <fingerprint>
ryco e2ee client clear-refusals            # zero the pending-cap refusal count
ryco e2ee client window open <fingerprint> # the discriminator is required
ryco e2ee client window close
ryco e2ee sessions                         # the advisory per-session code, for the web tier
ryco e2ee policy show
ryco e2ee policy set --mode <compatibility|require-e2ee|require-native-e2ee|require-locally-approved-native-e2ee> [--suite <id>]
ryco e2ee policy recover                   # advance a rolled-back policy generation
ryco e2ee prekey show
ryco e2ee prekey rotate
ryco e2ee continuity show
ryco e2ee continuity recover --adopt <continuity-id> | --break
ryco e2ee continuity break
ryco e2ee fallback show
ryco e2ee fallback reset
```

`client list`, `show`, `approve`, `narrow`, `revoke`, and `purge` take the record key in full —
`--hub-origin`, `--account-id`, and the `SHA256:` fingerprint — because a key is all three fields
and a fingerprint alone names records in scopes the owner did not touch.

Three of these carry guarantees rather than conveniences, and it is worth stating what they are.
**`client narrow` and `client revoke` do not return until every channel admitted under the withdrawn
authority is closed**, and they report how many they closed and how many in-flight handshakes they
aborted; an acknowledgement therefore means what an owner reads it to mean. **`policy set` warns
before it acts** — including the operator-lockout warning for `--require-approved-client-e2ee`,
which disables web and legacy access entirely and can strand remote access if every approved native
client key is lost — then runs the same ordered procedure and reports the closures broken out by
class. **`continuity recover` offers exactly two outcomes and defaults to neither**: re-adopting a
confirmed lineage id keeps every existing client verification, while breaking continuity mints a
fresh one and requires every paired client to verify this node again.

Two more are recovery paths rather than routine operations. **`policy recover`** is §5.7's command
for a node whose advertised policy generation is below its durable high-water mark — a restore
rolled the record back: it advances the generation past every value the node may have advertised,
warns that the jump is deliberate and that clients accept only a strictly higher value, and commits
the fail-closed policy rather than re-adopting restored values, so widening back is a separate
explicit `policy set`. **`prekey show`** reads the certificate the node holds without re-signing it,
which is the only surface on which an expired prekey — and §6.4's remedy for it — is visible at all.

`--json` emits one compact document on a single line, and that document is the whole of stdout:
logging is suppressed for the entire command, and answers that read as prose to a human ("no
enrollment is pending") are documents to a machine. Mandated warnings are not dropped under the
flag — they go to stderr and travel inside the document — because a flag that silenced a warning
would be the quiet way to skip one. Nothing on any of these surfaces carries a raw key, and the
fallback report carries no account, channel, session, or key identifier at all, because none is
stored. Normative definitions: `docs/relay-e2ee-protocol.md` §5.7, §6.4, §7.5, §12.3–§12.6,
§13.4–§13.6.

## Enrollment and key custody

Start Ryco with the connector enabled, then run these commands against the same Ryco state
directory:

```bash
ryco hub status
ryco hub login
ryco hub enroll
ryco hub pending
ryco hub cancel
ryco hub resume
ryco hub leave
```

Add `--json` for bounded machine-readable output. The server must be running.

`ryco hub login` links the node without leaving the terminal. It signs in to the Hub with the
native password login — the account's password and its second factor, prompted for and never taken
from arguments — under a DPoP key that exists only for the command. It then starts (or reuses) this
node's device-code enrollment, looks the enrollment up at the Hub, approves it only when the Hub's
public-key fingerprint equals the one the local node reported over its authenticated loopback API,
signs out, and waits for the connector to come online. No account credential remains on the node.
Accounts without a password — passkey- or GitHub-only — use `ryco hub enroll` and approve the code
in the Hub web app. The CLI obtains a
short-lived owner credential from the local auth control plane, uses it only in an Authorization
header to the existing local server, and revokes it after the operation. That credential is never a
Hub credential and never enters a Hub WebSocket.

`hub status` prints the active node's canonical `SHA256:<base64url>` identity fingerprint in both
human and JSON output whenever an active identity exists. This is the stable local recovery source
after enrollment has finished; it exposes no raw public key, private-key material, key-store name,
local path, Hub origin, or node identifier.

`hub enroll` prints the node label, platform, client version, key algorithm, the canonical
`SHA256:<base64url>` public-key fingerprint, expiry, and a short device code — the same fields the
Hub approval screen shows, so both can be compared item by item. `--json` returns the same bounded
fields. Compare every field, and the fingerprint exactly, with the Hub approval screen before
approving. Deny and investigate any mismatch; never approve by device code alone.

When no node name is configured, Ryco proposes `<machine label> · <node code>`. The four-character
Crockford Base32 node code is derived deterministically from the persistent EnvironmentId, so two
Ryco state directories on the same machine receive distinguishable, stable proposals. The complete
label is truncated without splitting a Unicode character and never exceeds 100 JavaScript UTF-16
code units. An explicit `--hub-node-name`, `RYCO_HUB_NODE_NAME`, or Desktop value replaces that
automatic proposal after trimming.

The exact proposal is persisted with a pending ceremony before the enrollment request is sent.
Restarting or changing launch configuration cannot silently change the label an owner is comparing
on the Hub. Once approved, the Hub's stored label is authoritative: a Hub owner can rename it from
the desktop/tablet node-detail surface, while node, viewer, and operator sessions cannot rename it.
The frozen web phone presentation displays refreshed names but does not expose node management.

`hub pending` reprints those fields for a ceremony that is already under way. The device code is
persisted as bounded non-bearer routing metadata so a comparison survives a lost terminal or a
restart; the polling secret is not, and stays in the protected store. A ceremony started before this
was persisted cannot be reprinted and reports as absent. Approval polling continues inside the running server and resumes from
protected local state after restart. `hub cancel` stops a pending ceremony and deletes its local key
and polling-secret custody. Denial or expiry requires starting a new ceremony.

The node creates its Ed25519 key locally. Private keys and enrollment polling secrets live in the
platform protected store described in [Node identity primitives](./node-identity.md). Local JSON
contains only bounded non-bearer metadata and protected-store references. The permissioned-file
fallback is opt-in, POSIX-only, and enforces `0700` directories and `0600` regular key files. An
enrolled node never silently replaces a missing, locked, or corrupt key.

The non-secret local identity state records the pending ceremony's exact proposed label and whether
its protected material belongs to the `os` or
`permissioned-file` custody class. Once material exists, Ryco reopens that same class on future
starts instead of silently switching because another backend became available. A legacy identity
without the marker is migrated only when all required material is found in exactly one eligible
store. Missing, split, or ambiguous custody fails closed as `identity_store_unavailable`.

One node identity belongs to one running backend. The desktop app's backend and a default
`ryco serve` both keep their state in `~/.ryco`, so a backend whose connector is switched on takes a
process lock, `hub-connector.lock`, beside the identity state before it builds its identity runtime.
A second backend that finds the lock held by a live process still opens the credential store, but
defers the rest of its startup work until it holds the lock: it does not finish an interrupted
leave, destroy retired keys, repair the prekey or continuity chain, or commit its launch E2EE
policy, so a narrower policy given to it cannot be committed where the first backend's live
channels would never be swept. Until then its policy reads as the fail-closed default, which is
also what it enforces, since it serves no channel. It does not sign with or connect as the identity:
it reports `connection_replaced`, checks again every 30 seconds to two minutes — at once when the
machine wakes, its network changes, or an owner command here takes the identity over — and takes
over by itself once the first one exits, running the deferred work first. Until it holds the lock it also
refuses everything that writes what the owning backend relies on — starting or cancelling an
enrollment, leaving, the desktop's native node claim and local trusted introduction, and every E2EE
owner command that changes state (client approval, narrowing, revocation and purge, approval QR
codes, the pairing window, policy changes and generation recovery, prekey rotation, continuity
commands, and the fallback reset). It does not read the continuity status either, because that read
runs the same chain repairs as startup: `ryco e2ee continuity show` answers `not read here` with a
sentence saying another copy of Ryco is using the identity, and the desktop's Security panel shows
that sentence in its Continuity row. The other reads are still answered, and the panel still draws
them; the prekey read reports the stored certificate without issuing one. A backend whose connector
is switched off or misconfigured does not hold the lock; it claims it for the length of a leave, one
of those operations, or a continuity read, and while another backend holds it, behaves as above.

A lock left by a process that died — or by one from before a reboot, whose pid may since have been
reused — is reclaimed automatically. The lock records the kernel's boot id where there is one (Linux
and macOS), so a wall-clock correction cannot make a live holder look like one from an earlier boot,
and on Linux the holder's start time, so a pid that a container restart handed to another process is
not mistaken for the holder. If the lock file cannot be read or written at all, the backend asks once
more, then proceeds without it and asks again each time it next needs the identity; the Hub still
allows only one connection per identity.

The standalone [relay architecture atlas](./relay-architecture.html) shows enrollment, client relay
connection, hosted reconnect, actor capabilities, role intersection, and which data each component
retains.

## Authentication

For every connection attempt, Ryco first requests a fresh proof challenge over HTTPS. It signs the
canonical node-authentication transcript with the selected local key, then opens
`wss://<configured-origin>/v1/relay/node`. The signed `auth` frame is the first WebSocket frame and
must complete within the negotiated five-second deadline.

The Hub honours a challenge for 30 seconds and rejects an expired one exactly as it rejects a wrong
key. Signing can be slow — a keychain access prompt, a slow custody backend, a machine suspended
mid-handshake. A challenge that took 23 seconds or more to sign, measured on the local clock from
before it was requested, may no longer survive the five-second socket open, so it is discarded and
replaced once before the socket opens; the replacement's proof is sent however long it took, rather
than asking for a third signature. A relay rejection of a proof that was 20 seconds or more old when
sent is retried once with a fresh challenge before it counts as a rejection.

Node WebSockets do not use cookies, Authorization headers, URL credentials, query parameters, or
bearer subprotocols. A challenge is single-use and in memory only. Replayed proofs, copied node IDs,
and wrong or rotated keys are refused with `authentication_failed`, which is retried only on the slow
schedule described below — every retry uses a fresh challenge and the Hub's full verification, so a
refused key gains nothing from it. Successful
authentication with an activated staged key confirms rotation locally and removes superseded key
custody according to the node-identity rules.

Revocation enters `revoked` and requires re-enrollment or an approved recovery procedure. An
unsupported relay version enters `version_incompatible`. Repeated pre-stability protocol violations
fail closed for operator action. Ryco never enters a tight retry loop for a rejection, a replacement,
or a protocol violation.

## Connector states and reconnect policy

Local status exposes only these bounded states:

| State                  | Meaning                                                                           |
| ---------------------- | --------------------------------------------------------------------------------- |
| `disabled`             | No polling, socket, reconnect timer, or relay channel exists.                     |
| `enrolling`            | Enabled and ready to start device-code enrollment.                                |
| `awaiting_approval`    | A protected enrollment ceremony is being polled.                                  |
| `connecting`           | Proof preflight or network connection is in progress.                             |
| `authenticating`       | The auth frame was sent and Ryco is waiting for `ready`.                          |
| `online`               | Protocol 1.2 or 1.3 is negotiated; bounded channel and queue counts are included. |
| `degraded`             | Backing off automatically or waiting for operator action.                         |
| `revoked`              | The node was revoked; automatic reconnect is stopped.                             |
| `version_incompatible` | The peer version is unsupported; automatic reconnect is stopped.                  |
| `stopping`             | New work is rejected while resources are closed.                                  |

DNS, network, TLS, authentication timeout, Hub draining, rate limiting, heartbeat timeout, slow
consumer, and isolated internal transport failures retry automatically. Backoff is exponential,
uses bounded jitter, honors a bounded `retryAfterMs`, and caps at the configured maximum. The
attempt counter resets only after the connection remains online for the configured stable interval.
Only one connection generation and one reconnect timer can exist for the configured Hub.

Three failures usually clear on their own but could be real, so they retry on their own, much
slower, schedules — reported as `backing_off` with the specific failure code and the next retry time,
so status says both what went wrong and that the connector is handling it:

| Failure                 | First retry | Grows to   | Notes                                                       |
| ----------------------- | ----------- | ---------- | ----------------------------------------------------------- |
| `identity_unavailable`  | 30 seconds  | 10 minutes | A wake or network change retries at once.                   |
| `connection_replaced`   | 5 minutes   | 15 minutes | At most three an hour, then it stops for operator action.   |
| `authentication_failed` | 15 minutes  | 1 hour     | Covers a refused proof; an explicit revocation stays final. |

Each delay is jittered and never shorter than its first retry. The replacement budget is what lets
two processes sharing an identity converge: each retry displaces the other copy, so retrying forever
would be the flapping itself. The Hub displaces the older connection for an identity either with a
`connection_replaced` error frame or by closing it with code 1012 and reason `connection_replaced`;
both are recognized, and only that exact close is — any other close is an ordinary network drop. A
custody read that fails at startup or on `resume` takes the same
path as one that fails mid-connection.

Configuration, a credential store that could not be opened at all (`identity_store_unavailable`),
origin mismatch, enrollment failure, revocation, version incompatibility, and repeated early
protocol failure require operator action. Restarting the process does not make a revoked identity
retry. The Hub's
proof-preflight route never refuses a node by status — it issues a challenge to every well-formed
request and answers 400 only for a malformed one — so any other client error there (401, 403, 404,
408, and the rest) comes from a proxy, CDN, or WAF in front of the Hub and retries like a network
failure. A 400 means this node and the Hub disagree about the request shape: it retries once, then
stops for an update like any repeated protocol failure.

The connector also watches for the two events that silently kill an outbound socket: the machine
waking from sleep (its wall clock jumps past its timers) and its external addresses changing. An
online connector then sends its own `ping` and reconnects if the matching `pong` does not arrive
within five seconds; a connector backing off retries at once with a fresh backoff — except a slow
retry after the Hub displaced this node (`connection_replaced`) or refused its proof
(`authentication_failed`), whose spacing is the point. Waiting out another local backend's lock,
also reported as `connection_replaced`, is a file check and is brought forward too. Only the answer
to the connector's own outstanding probe is accepted; an unsolicited `pong` remains a protocol
violation.

`ryco hub leave` erases this node's local Hub identity: the active signing key, any staged rotation
key, a pending ceremony's key, and any polling secret still awaiting cleanup. It is the only exit
from `revoked` and from a corrupt identity, because `resume` will not restart a revoked identity and
enrollment refuses to start while an active node exists.

It is destructive and distinct from turning the connector off, which is reversible and keeps the
key. Leaving mints a fresh EnvironmentId, so the node can enrol again — as a **new** node, needing a
new approval. It does **not** revoke anything at the Hub: the previous node record survives there
until an owner removes it.

The erase is crash-safe. A durable marker records the intent and every secret to remove before
either store is touched, so an interrupted leave is completed on the next start rather than
orphaning key material or leaving state that points at keys which are already gone.

`ryco hub resume` retries now instead of on the connector's own schedule, and prints the resulting
status. It also resets the slow-retry budgets, so after stopping a duplicate process or unlocking a
credential store the next attempt is immediate and a stopped `connection_replaced` gets a fresh
hourly budget. Resume is deliberately a no-op for `revoked`, for a stopping connector, for a
disabled one, and for a connection that is already up or on its way up — it reports the unchanged
state rather than implying it acted.

## Relay channels, limits, and roles

Ryco accepts protocol 1.2 `channel.open` frames and the strict protocol 1.3 extension above, always
with capability `ryco.rpc`, an effective role, and room under the negotiated channel limit. Every
other open is rejected. Each
accepted logical channel owns an isolated RPC byte-session scope and uses the same application
handlers and services as direct Ryco WebSocket clients. Provider, terminal, orchestration, project,
and persistence logic is not duplicated.

The channel's effective role is enforced by an exhaustive RPC access policy. `viewer` can perform
read-only operations, `operator` can run ordinary workspace mutations, and `owner` can change
credentials, providers, MCP or Atlassian configuration, diagnostics, and server policy. Local auth
credential subscription remains direct-owner-only even for a relayed owner channel. Methods without
an explicit classification fail closed.

Application bytes remain opaque to the relay adapter and are copied byte-for-byte in sequence.
Per-channel sequence violations, transfer limits, slow consumers, or application session closure
close only that channel. They do not close the connector, local clients, or unrelated channels
unless a bounded connector control frame can no longer be retained safely. Frames the Hub forwarded
before it learned that the node closed a channel are ignored for a bounded set of recently closed
channels; a frame naming a channel that never existed remains a protocol violation.

An RPC response the send path refuses is never dropped silently: a dropped stream chunk would stall
its subscription forever, since streams wait for each chunk's acknowledgement. Backpressure is
waited out in order for up to 30 seconds; a response too large for the channel fails only its own
request (and interrupts a stream that produced it); anything else — or backpressure that outlasts
the wait — ends the channel, with §10's authenticated close when it can still be sent, so the client
reconnects with fresh state.

Negotiated `maxChannels`, `maxDataChunkBytes`, `maxQueuedBytes`, and control-frame limits are
enforced on both directions. Connector queues and RPC input queues are bounded. Control frames have
reserved capacity, channel data is scheduled fairly, and native WebSocket `bufferedAmount` counts
toward the owned byte budget. No relay payload is written to persistence, diagnostics, traces, or
logs.

`flow.pause` stops outbound scheduling for only the named channel; `flow.resume` restarts it in
order. Ryco emits the corresponding inbound pause before an RPC input queue reaches its high-water
mark, tolerates only the negotiated grace, and polls the bounded queue until it can resume. A peer
that continues beyond the grace is closed as a slow consumer.

## Heartbeat and shutdown

Hub sends a ping on the negotiated 20-second cadence. Ryco immediately queues a byte-exact pong and
uses the negotiated 45-second dead-connection timeout. Only a valid Hub ping refreshes that timer;
ordinary relay traffic does not mask a missing heartbeat.

Server shutdown invalidates the active connection generation before cleanup. It stops enrollment
and reconnect timers, rejects new channels, closes every channel scope and queue, closes the Hub
socket, removes socket listeners, and clears heartbeat, stability, and drain timers. Local clients
and the normal server listener follow their existing shutdown path.

## Troubleshooting

- `configuration_invalid`: check the exact boolean spellings, HTTPS origin, and reconnect ranges.
- `identity_unavailable`: the credential store is locked or unreadable. Ryco retries on its own;
  unlock or restore the store and run `ryco hub resume` to retry at once. Do not copy a node ID or
  generate a replacement key manually.
- `identity_store_unavailable`: the credential store could not be opened at all when this process
  started, and no retry can repair it. Fix the store, then restart Ryco. On headless Linux this is
  usually a missing Secret Service; `ryco setup` detects that and offers the explicit
  permissioned-file fallback.
- `enrollment_expired`: the ceremony's own expiry passed. Start a new one.
- `identity_origin_mismatch`: use the origin to which the identity was enrolled or perform an
  approved re-enrollment.
- `enrollment_unavailable`: the ceremony was denied or cancelled at the Hub. Find out why before
  starting another; a denial is a human saying no.
- `authentication_failed`: the Hub refused this node's proof. Ryco retries every 15 minutes to an
  hour in case the cause was on the Hub's side; if it persists, verify approval, key rotation, and
  node status with the Hub operator. A node that was removed at the Hub needs `ryco hub leave` and a
  new enrollment.
- `revoked`: retries are intentionally stopped. `ryco hub resume` will not restart a revoked identity.
- `connection_replaced`: another process is using this node's identity — locally, another Ryco
  backend on the same state directory holds its lock; remotely, a copy of the identity
  authenticated elsewhere. A local copy is waited out automatically. A remote one is retried a few
  times an hour, then Ryco stops so the other copy keeps the connection. Stop the copy you do not
  want, then run `ryco hub resume`. If no other Ryco backend uses this state directory and status
  still reports a local copy, the lock outlived its holder in a way Ryco could not detect: delete
  `hub-connector.lock` beside `hub-identity.json` in the state directory, then run
  `ryco hub resume`. Never delete it while another backend runs — both would then connect, and the
  Hub would displace one of them.
- `protocol_invalid` or `version_incompatible`: upgrade the incompatible endpoint. Do not modify
  relay schemas or fixtures locally.
- Repeated `network_unavailable`, `tls_unavailable`, or `heartbeat_timeout`: check DNS, egress, TLS
  trust, and network policy. Status reports a bounded next-retry time without exposing the Hub URL.
- `slow_consumer`: reduce concurrent activity or investigate the receiving endpoint; connector
  buffering will not grow to absorb sustained overload.

Status and errors intentionally omit origins, hosts, routes, keys, challenges, nonces, signatures,
tickets, credentials, payloads, filesystem paths, and raw peer error text.
