# Push alerts for native devices

The phone gets an alert when a turn finishes, fails or stops, or a thread needs an approval, an answer
or a plan decision — also while the app is suspended or closed. The Hub carries the alert but never
reads it: the node decides when to alert, seals a small payload to the phone, and the phone's
notification extension opens it.

This page is the protocol. What the client feeds and shows while it runs is in
[thread notification events](./thread-notification-events.md).

## Who does what

| Part   | Does                                                                                      | Never                                    |
| ------ | ----------------------------------------------------------------------------------------- | ---------------------------------------- |
| Node   | Runs the alert rules over its own shell, seals one payload per registered device, signals | Sends anything readable to the Hub       |
| Hub    | Maps the signal's enrollments to APNs tokens and sends a generic, mutable-content alert   | Opens or stores the sealed payload       |
| Device | Registers a push key with each node and an APNs token with the Hub; opens payloads        | Gives a push key to anything but its NSE |

## Keys

Each app installation has one X25519 **push key**, separate from its E2EE identity and agreement keys.
The app creates it natively and keeps the private half in a keychain group it shares with its
Notification Service Extension, readable after first unlock (the extension runs while the phone is
locked). Its id is the first 16 bytes of SHA-256 over the public key, in base64url (22 characters).

A stolen push key opens only alert payloads. The key is replaced on sign-out, reinstall, or when the
user resets background alerts.

## Registration

**With each node** — over the device's own relay channel, which must be account-enrolled (relay minor
3): the Hub addresses a device by its enrollment, so a locally approved or direct connection cannot
receive push.

| RPC                     | Payload                                 | Result                                 |
| ----------------------- | --------------------------------------- | -------------------------------------- |
| `push.registerDevice`   | key id, public key, wanted kinds, sound | status: kinds after role, Hub delivery |
| `push.unregisterDevice` | key id, optional public key             | whether it was removed                 |
| `push.setPresence`      | `foreground` or `background`            | this device's registration, as held    |

- The node takes the enrollment and role from the channel's verified grant, never from the payload, so
  a device can only register itself.
- One registration per enrollment, at most 64 per node, kept in `hub-push.json` beside the node's Hub
  identity state. A registration nobody refreshed for 30 days is dropped; the app sends it again on
  a connect unless that node confirmed exactly this registration (below), and at least daily. Leaving the Hub erases them; a revoked enrollment is dropped at once.
- A viewer never gets approval, input or plan alerts: it cannot act on them.
- `push.setPresence` answers the device's registration as the node holds it, without writing it, so
  the app registers again only when the node lost it (it left its Hub, or dropped it). Older nodes
  answer `{}`.
- `push.unregisterDevice` with the key's public half removes the registration holding exactly that
  key, whichever enrollment made it. Only the installation that created the key and the nodes ever
  hold its public half, and a device wrongly named would register again on its next connect. A
  reinstalled app uses it to retire the key its earlier installation left (below). Older nodes
  ignore the public key and remove only the caller's own registration.
- `foreground` holds for 90 seconds unless repeated (45 seconds on older nodes). Every status answer
  announces it as `foregroundHoldMs`; the app repeats `foreground` within half of the announced hold,
  at most every 40 seconds, and every 30 seconds to a node that announces none. While it holds, the
  node sends that device nothing: the app's own local alerts cover the screen, including leaving out
  the thread on screen. Only `background` leaves the app: a Notification Center pull or the app
  switcher peek (`inactive`) keeps it in front, for presence and local alerts alike.

**With the Hub** — `PUT /api/native/push/registration` with the native session: platform, APNs token,
`production` or `sandbox`, and the app's bundle id. One registration per device enrollment; the latest
token wins. `DELETE` removes it. `GET /api/native/push/capability` says whether the Hub can send push
and to which bundle ids; a Hub without push answers 404.

## The node's decision

The node runs the clients' own `createThreadNotificationProjector` over its shell, with the Inbox's
snooze rule, so alerts follow the same rules everywhere. It baselines when it starts: a restart never
replays old transitions.

- Domain events mark threads; marked threads are re-read on a 150 ms debounce, so a streaming turn
  costs one row read per pass.
- A thread's alert waits one second and a newer one replaces it: an approval answered and completed
  in that time sends one alert.
- Nothing is sent while the connector is offline. Alerts are perishable; there is no backlog.

## Sealing: `ryco-push-seal-v1`

The payload is compact JSON, a few hundred bytes, or up to about two kilobytes with an excerpt:

```json
{
  "v": 1,
  "k": "approval",
  "t": "Fix the login race",
  "e": "env_…",
  "th": "…",
  "tu": "…",
  "rq": "…",
  "q": 1793234112000,
  "at": 1793234112000
}
```

`k` is the kind, `t` the thread title (at most 120 characters), `e` the node's Hub environment id, `th`
and `tu` the thread and turn, `q` the signal's sequence and `at` when it was sealed. An approval also
carries `rq`, the request id of the newest approval waiting (the shell's `pendingApprovalRequestId`,
at most 160 characters; left out when longer, and by older nodes). A newer approval in the same turn
seals a new alert with its own `rq`, which replaces the older one on the lock screen.

### The excerpt `x`

An approval or question alert also carries what the person is asked, so the Lock Screen can show it
and the thread opens with its card already there. Older phones ignore it; older nodes never send it.

```json
{ "x": { "a": { "k": "command", "d": "npm run deploy -- --prod", "r": "Ships the fix" } } }
{ "x": { "u": { "rq": "…", "ev": "…", "qs": [{ "id": "target", "h": "Target",
  "q": "Where should it deploy?", "o": ["Staging", "Production"], "m": true }], "c": true } } }
```

- `a`, an approval: the request kind, the command or path (`d`) and the provider's reason (`r`),
  exactly the open request the thread's card shows: the node reads it from its own open-request
  tables and the activity that asked, one indexed read per alert, only while it is still open.
- `u`, a question: its request id, its request event id (`ev`, the key of the app's answer draft),
  and its questions with header, text, option labels (descriptions left out) and multi-select.
  `c` says questions or options were left out to fit.
- At most 1 KB of JSON (`PUSH_ALERT_EXCERPT_MAX_BYTES`), and the whole plaintext must fit the seal
  the Hub takes: the reason goes first, then questions and options, then text is cut, ending with
  "…". When nothing fits, the alert goes without one. A failed read never holds the alert up.

**Size.** Every Hub takes a sealed blob of 1,024 bytes (`PUSH_SEALED_LEGACY_MAX_LENGTH`, 1,366
base64url characters). A Hub that takes 2,048 bytes says so in its answer (`sealedMaxLength`, at most
`PUSH_SEALED_MAX_LENGTH`, 2,731 characters); the node seals to the legacy size until an answer says
more, so an older Hub keeps working and its alerts carry a shorter excerpt. With the Hub's own
fields the APNs payload stays near 3 KB, under its 4 KB limit, and a node splits a pass into
signals of at most about 56 KB (19 deliveries at the larger size).

To seal to the device key `R`:

1. Draw an ephemeral X25519 pair `(e, E)` and compute `dh = X25519(e, R)`; an all-zero `dh` is refused.
2. `HKDF-SHA256(ikm = dh, salt = E ‖ R, info = "ryco push seal v1")`, 44 bytes: a 32-byte key, then a
   12-byte nonce. Every key seals exactly one message.
3. ChaCha20-Poly1305 with associated data
   `"ryco-push-v1\n" ‖ environmentId ‖ "\n" ‖ decimal(sequence) ‖ "\n" ‖ enrollmentId`.
4. The blob is `0x01 ‖ E ‖ ciphertext ‖ tag`, sent as base64url.

The associated data binds the blob to the cleartext routing the Hub sees, so the Hub can neither move
a blob to another device nor replay it under another sequence. `packages/shared/src/pushSeal.ts` is the
reference; `pushSeal.vectors.json` pins it, and its test checks the vectors against an independent
implementation on Node's own crypto. The extension's Swift implementation must open the same vectors.

The **collapse id** is HMAC-SHA256 under the registration's own random salt over
`environmentId ‖ "\n" ‖ threadId`, first 16 bytes. A newer alert for a thread replaces the older one
on the lock screen; the Hub learns only that two alerts share a thread.

## The signal

`POST /api/node/attention/signal` with a fresh node proof (the same proof cloud thread history uses):

```json
{ "proof": { … }, "sequence": 1793234112000, "issuedAt": 1793234112000,
  "deliveries": [{ "enrollmentId": "enr_…", "sealed": "…", "collapseId": "…" }] }
```

- At most 32 deliveries per signal; more alerts in one pass use more signals.
- `sequence` grows with every signal the node sends and never falls below the clock in milliseconds,
  so it keeps growing across restarts even if the state file is lost.
- The answer lists a status per delivery: `sent`, `no-registration`, `not-authorized`, `rate-limited`
  or `failed`. The node forgets a device the Hub answers `not-authorized` for.
- A failed signal is retried once after five seconds with the same sequence and payload, then dropped.
- An HTTPS route rather than a relay frame: a Hub closes a node's whole connector on a frame it does not
  know. An older Hub answers 404; the node then asks again only after an hour.

The Hub must check, per delivery: the enrollment is active, its account still has access to this node,
and the account registered that device for push. It must refuse a sequence at or below the node's last
accepted one, answering a repeat of that exact signal without sending again. It never stores `sealed`.

## APNs delivery

The Hub sends an `alert` push (`apns-priority: 10`, `apns-collapse-id` from the delivery,
`apns-expiration` one hour after `issuedAt`) with no readable content:

```json
{
  "aps": {
    "alert": { "title": "Ryco", "body": "A thread needs your attention" },
    "mutable-content": 1,
    "sound": "default"
  },
  "ryco": { "v": 1, "e": "env_…", "q": 1793234112000, "n": "enr_…", "s": "<sealed>" }
}
```

The extension reads `ryco`, opens `s` with the push key and the associated data from `e`, `q` and
`n`, and checks that the payload's `e` and `q` match. It then shows the thread title, a line for the
kind, with an excerpt the command ("Run command: npm test") or the first question as the body and
the thread title as the subtitle, stacks alerts per thread (`threadIdentifier` `<environment>/<thread>`), and sets the kind's
category, so the alert offers the same actions as the app's own (below). iOS's own Show Previews
setting decides whether the title, subtitle and body show on a locked phone. On any failure, or
past its time limit, the generic text stays and a tap opens the app: the extension also drops the
Hub's own `body` and `url`, so only an opened payload can name the thread a tap opens.

### The excerpt in the app

The extension leaves an opened excerpt for the app in the App Group they share, one small file per
thread (`AlertExcerptStore`, named by a hash of the ids, readable after the first unlock): the
thread, kind, turn, request, when it was sealed, and the excerpt with only the keys above. A newer
alert for the thread replaces it; it counts for two hours, like the alert; the app removes it once
the thread's live detail loaded, and all of them go with the push key.

When a thread opens, by a tap on the alert or any other way, before its live detail loaded, the
app reads that file and shows the card it describes. It is provisional and never bypasses the
connection:

- **Allow / Deny** on an approval become the same pending action as the alert's own buttons
  (below): carried out for that request id once the thread is live, refused there when it was
  answered meanwhile, given up after two minutes without a ready connection.
- A **question**'s choices go into the same draft the live card reads (keyed by `ev`), so nothing
  picked is lost; Submit works on the live card.
- The live detail replaces the card as soon as it loads.

## The iPhone app

Settings → Inbox → Alerts has a **When Ryco is closed** switch under thread alerts. Until the user
turns it on, the app asks the Hub only for its capability, to explain the row. Once on, and only
when the Hub can send to this build's bundle id:

1. the `ryco-push` native module creates the push key; the `RycoNotificationService` extension
   shares its keychain group (both added by `plugins/withIosNotificationServiceExtension.cjs`);
2. the app records its enrollment id and the sound setting with the key, for the extension;
3. it reads the APNs token, registers it with the Hub, then calls `push.registerDevice` once on every
   Hub channel each time it connects, and `push.setPresence` while it is in front. A node whose
   presence answer confirmed exactly this registration (same key, enrollment, kinds, sound and Live
   Activity setting; kept in the app's storage across restarts) is not registered again on a
   connect: the presence the connect sends anyway asks whether it still holds it, and a node that
   says otherwise, a change of setting, or a confirmation older than a day registers again. A
   node's answer is kept for that connection: an older node or a channel that cannot receive push is
   asked again on the next connect, a failure after a minute or on the next foreground;
4. once the Hub took the token and a node reports `hubDelivery: available` for a kind, the app stops
   posting its own background alert of that kind for that machine, so the two never double up. In
   front nothing changes. A node reports `offline` from its start until its first delivered signal;
   each presence answer carries what it reports now, and the app registers again only when the
   answer says the registration is gone (or names another key). An older node answers presence with
   nothing: while it has not confirmed delivery, the app asks it again with each presence refresh and
   on coming back. Either way the app keeps posting its own alerts until delivery is confirmed, since
   a missed alert is worse than a double one.

**App icon badge.** The badge shows how many threads need the person (the Inbox's "needs you",
the Live Activity's rule, over every machine). Each sealed alert carries the sending node's count
(`b`, optional: older nodes leave it out, older apps ignore it); the extension keeps each machine's
last known count in a keychain item of its own beside the key (`PushBadgeStore`, counts only) and
sets the badge to their sum. While the app runs with thread alerts on, it writes the live counts of
the machines it is connected to over those, drops machines it no longer lists, and clears the badge
when alerts are turned off or the account signs out. The alert permission asks for badges too.

Turning it off removes the Hub registration, the connected nodes' registrations and the key. Any key
means a Hub registration may exist, so its removal is recorded in the app's storage before the key
goes and retried on the next foreground or launch until the Hub confirms it (a 404 counts as
removed). Signing out, or into another account, deletes the key, and the Hub drops the registration
with the session.

The key belongs to the installation. The keychain keeps it across a delete and reinstall, so it has
an install marker in the app's storage, like the E2EE keys: at every launch, also when the new
installation never turned background alerts on, a key without the marker is deleted before anything
uses it.

The earlier installation's registrations outlive it: its nodes hold its key under its own
enrollment, and the Hub its token. Before deleting that key, the install check keeps its public half
in the app's storage. Background alerts then start, also when this installation never turned them
on, and retire it on every Hub machine the app lists with `push.unregisterDevice` and the public key.
Once each has answered, or after 30 days (when nodes drop a registration nobody refreshes), the
public key is forgotten. With no node registration left, no node signals the Hub for that
enrollment, so the Hub's leftover registration for it gets nothing to deliver. The app cannot remove
that Hub registration itself: it is keyed by the earlier installation's enrollment and session.

## Kinds and actions

Settings → Notifications lists the six kinds; a kind turned off is left out of the app's own alerts
and of the `kinds` the device registers, so the node never seals it. With every kind off,
background alerts count as off.

Every alert has a category (`src/notifications/notificationActionsModel.ts`, and the extension's
`kindCategories`): **Approve / Deny** on an approval, **Reply / Open** on a question, a plan, or a
result. Each action needs an unlocked phone and opens Ryco: answering needs a live, authorized
connection with a current shell, which a suspended app does not have, so nothing is answered from
the background. The response becomes a pending action for that thread, and the thread's screen
carries it out with its own approval and send handlers once its connection is ready for mutations.
Approve and Deny answer only the approval the alert names (a local alert's `requestId`, the opened
payload's `rq`), once the thread's live detail has loaded: never another approval of the same turn,
and nothing at all from an alert that names none. When that approval was answered meanwhile, or two
minutes pass without a ready connection, the screen says why and the person answers there.

Reply is a message of its own: it never declines waiting approvals and never touches a queued message
being edited. When the thread waits on a question, Reply answers it if its text can be the answer (one
question without options); a question with options is answered on its card, and the reply is not
sent. Otherwise a reply that finds no ready connection within 15 seconds goes to the outbox like any
message typed offline, unless the composer is closed. Links never start an action.

Tapping an alert, also the one that launched the app, opens its thread once; an alert for the thread
on screen does not show while the app is in front.

The agent Live Activity can take push updates through the same Hub registration: see
[Live Activity push updates](./live-activity-push.md).

## Versions

| Combination                             | What happens                                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Older app                               | Never registers; local alerts as before                                                                                         |
| New app, older node                     | `push.registerDevice` is unknown; the app asks to update the machine                                                            |
| New app, node without presence answers  | Presence answers `{}`; the app registers again until delivery is confirmed; the earlier installation's key is not retired there |
| Older app, newer node                   | The presence answer's registration and the public key are ignored; the excerpt is never read                                    |
| New node, Hub without `sealedMaxLength` | Alerts are sealed to 1,024 bytes; the excerpt is cut to fit                                                                     |
| New node, Hub without the signal route  | Registrations are kept; nothing is sent; status `hub-unsupported`                                                               |
| Build without the extension             | Push stays off (Personal Team builds cannot sign one)                                                                           |
