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
| `push.unregisterDevice` | key id                                  | whether it was removed                 |
| `push.setPresence`      | `foreground` or `background`            | —                                      |

- The node takes the enrollment and role from the channel's verified grant, never from the payload, so
  a device can only register itself.
- One registration per enrollment, at most 64 per node, kept in `hub-push.json` beside the node's Hub
  identity state. The app registers again on every connect; a registration nobody refreshed for 30
  days is dropped. Leaving the Hub erases them; a revoked enrollment is dropped at once.
- A viewer never gets approval, input or plan alerts: it cannot act on them.
- `foreground` holds for 45 seconds unless repeated. While it holds, the node sends that device
  nothing: the app's own local alerts cover the screen, including leaving out the thread on screen.

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

The payload is compact JSON, at most a few hundred bytes:

```json
{
  "v": 1,
  "k": "approval",
  "t": "Fix the login race",
  "e": "env_…",
  "th": "…",
  "tu": "…",
  "q": 1793234112000,
  "at": 1793234112000
}
```

`k` is the kind, `t` the thread title (at most 120 characters), `e` the node's Hub environment id, `th`
and `tu` the thread and turn, `q` the signal's sequence and `at` when it was sealed.

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
kind, and stacks alerts per thread (`threadIdentifier` `<environment>/<thread>`). On any failure, or
past its time limit, the generic text stays and a tap opens the app: the extension also drops the
Hub's own `body` and `url`, so only an opened payload can name the thread a tap opens.

## The iPhone app

Settings → Inbox → Alerts has a **When Ryco is closed** switch under thread alerts. Until the user
turns it on, the app asks the Hub only for its capability, to explain the row. Once on, and only
when the Hub can send to this build's bundle id:

1. the `ryco-push` native module creates the push key; the `RycoNotificationService` extension
   shares its keychain group (both added by `plugins/withIosNotificationServiceExtension.cjs`);
2. the app records its enrollment id and the sound setting with the key, for the extension;
3. it reads the APNs token, registers it with the Hub, then calls `push.registerDevice` once on every
   Hub channel each time it connects, and `push.setPresence` while it is in front. A node's answer is
   kept for that connection: an older node or a channel that cannot receive push is asked again on
   the next connect, a failure after a minute or on the next foreground;
4. once the Hub took the token and a node reports `hubDelivery: available` for a kind, the app stops
   posting its own background alert of that kind for that machine, so the two never double up. In
   front nothing changes. A node reports `offline` from its start until its first delivered signal;
   while it has not confirmed delivery, the app asks it again with each presence refresh and on
   coming back, and keeps posting its own alerts, since a missed alert is worse than a double one.

Turning it off removes the Hub registration, the connected nodes' registrations and the key. Any key
means a Hub registration may exist, so its removal is recorded in the app's storage before the key
goes and retried on the next foreground or launch until the Hub confirms it (a 404 counts as
removed). Signing out, or into another account, deletes the key, and the Hub drops the registration
with the session.

The key belongs to the installation. The keychain keeps it across a delete and reinstall, so it has
an install marker in the app's storage, like the E2EE keys: at every launch, also when the new
installation never turned background alerts on, a key without the marker is deleted before anything
uses it.

## Versions

| Combination                            | What happens                                                         |
| -------------------------------------- | -------------------------------------------------------------------- |
| Older app                              | Never registers; local alerts as before                              |
| New app, older node                    | `push.registerDevice` is unknown; the app asks to update the machine |
| New node, Hub without the signal route | Registrations are kept; nothing is sent; status `hub-unsupported`    |
| Build without the extension            | Push stays off (Personal Team builds cannot sign one)                |
