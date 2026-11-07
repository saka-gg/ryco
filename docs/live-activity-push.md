# Live Activity push updates

The phone's agent Live Activity (Lock Screen card and Dynamic Island) is local today: the app
starts, updates and ends it while it runs, and once iOS suspends the app the card reads "Out of
date" at its stale date. Push updates keep it current while the app is suspended or closed: the
Hub sends `liveactivity` pushes to the card's update token.

This page is the protocol and what the Hub must do. The app side and the contracts are in this
repository; the Hub's sender is not. Background alerts, which this builds on, are in
[push alerts](./push-alerts.md).

## The one rule

**A pushed card carries counts only.** The Hub cannot read thread content (titles, projects,
models, links are end-to-end encrypted between the node and the phone), and APNs delivers a Live
Activity's content state as is: there is no notification service extension in between to open a
sealed payload. So a push update holds four numbers and nothing else:

```json
{
  "v": 1,
  "origin": "remote",
  "counts": { "running": 2, "needsYou": 1, "failed": 0, "done": 0 },
  "updatedAt": 1793234112000
}
```

`LiveActivityRemoteContentState` in `packages/contracts/src/pushHub.ts` is the schema;
`modules/ryco-widgets/ios/AgentActivityContentState.swift` decodes it (`rows` and `url` stay
absent). The card then shows the counts ("1 needs you · 2 running"), the lead glyph and the
compact Island word for what the person is asked to do; a tap opens Ryco, which replaces the card
with its own rows as soon as it runs. Never add a title, project, model, thread id or link to a
pushed state, also not hashed or truncated.

## Who does what

| Part   | Does                                                                                                    | Never                                  |
| ------ | ------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Device | Requests the card with `pushType: .token`, hands its update token to the Hub with its push registration | Starts a card from a push              |
| Node   | Counts its threads per registered device and signals the Hub (reserved, below)                          | Sends titles or thread ids to the Hub  |
| Hub    | Keeps the token, sums the counts across the account's nodes, sends `liveactivity` update and end pushes | Stores or forwards anything but counts |

There is no push-to-start: a card only ever starts while Ryco is in front, so it never appears
unannounced, and the token always belongs to a card the person saw start.

## Capability

`GET /api/native/push/capability` answers `liveActivities: true` once the Hub takes Live Activity
tokens and sends updates. Until then the app never asks iOS for a token and every card is local, so
an older Hub sees nothing new. A Hub must only say so for topics it can send `liveactivity` pushes
to (the APNs topic is `<bundle id>.push-type.liveactivity`).

## Tokens

The token rides on the device's own push registration, `PUT /api/native/push/registration`
(`NativePushRegistrationInput`):

```json
{
  "platform": "ios",
  "token": "<device token>",
  "environment": "sandbox",
  "topic": "dev.ryco.app.dev",
  "liveActivityToken": "<hex>"
}
```

- The app sends `liveActivityToken` only to a Hub whose capability says `liveActivities`, and only
  while the Live Activity switch is on and a card shows.
- **Latest wins.** A registration without `liveActivityToken` drops the one the Hub held: the card
  ended, was swiped away, or the switch went off. `DELETE` drops both tokens.
- **Rotation.** iOS may hand a card a new update token at any time; the app registers again with
  it. The Hub replaces the old one and must not send to it again.
- One card per device: a device has at most one Live Activity token.
- Keep it with the device registration's lifetime: sign-out, a revoked enrollment, or an account
  that lost access to its nodes drops it, exactly like the device token.

## The node's half (reserved)

The device tells each node, in `push.registerDevice`, that its card takes push updates
(`liveActivity: true`). The node keeps the flag with the registration (`hub-push.json`); older
nodes ignore it.

The node does not send counts yet. When it does, it is `POST /api/node/attention/activity` with a
fresh node proof (`PushActivitySignalInput`):

```json
{ "proof": { … }, "sequence": 1793234112001, "issuedAt": 1793234112001,
  "activities": [{ "enrollmentId": "enr_…", "counts": { "running": 1, "needsYou": 1, "failed": 0, "done": 0 } }] }
```

- One entry per registration with `liveActivity`, at most 32 per signal, with the same counting
  rule as the card (`summarizeAgentActivity`: live threads only, a result counts for 15 minutes,
  snoozed and settled threads never).
- The same sequence counter as the attention signal, the same proof, retry and 404 back-off rules.
- Nothing for a device in front: presence holds as for alerts, and the app updates its own card.
- Only when the counts changed for that device, coalesced with the attention pass.

The Hub must check every entry like an attention delivery: the enrollment is active, its account
still reaches this node, and that device registered a Live Activity token.

## Sending

The Hub keeps, per device, the latest counts from each of the account's nodes and sends their sum.
A node that went offline drops out of the sum after the stale window (10 minutes): its threads can
no longer be called running.

An update:

```http
apns-push-type: liveactivity
apns-topic: <bundle id>.push-type.liveactivity
apns-priority: 5
apns-expiration: <now + 10 minutes>
```

```json
{ "aps": { "timestamp": 1793234112, "event": "update", "content-state": { … }, "stale-date": 1793234712 } }
```

- `timestamp` is seconds and must grow; iOS drops an update older than the one it shows (the app's
  own updates carry their own timestamps, so a late push never overwrites a newer local state).
- `stale-date` is `timestamp + 600`: past it the card reads "Out of date" by itself.
- Priority **10** only when `needsYou` grew (something new waits on the person); everything else
  goes at **5**. iOS budgets priority-10 Live Activity pushes per app; a Hub that spends them on
  routine counts gets throttled.
- Coalesce: at most one update per device per 15 seconds, the latest counts winning; never send
  counts equal to the last ones sent.
- An `alert` inside the update is not used: background alerts already announce what needs the
  person, sealed and with the thread's title.

The end, once all four counts are zero or every node dropped out:

```json
{ "aps": { "timestamp": 1793234112, "event": "end", "content-state": { … }, "dismissal-date": 1793235012 } }
```

- `dismissal-date` is 15 minutes on with a final state (the card shows its results as long as the
  app's own end does), or 15 seconds on without one.
- After an end the token is spent: drop it, send nothing more, and wait for the next registration.

## Errors and limits

| APNs answer                                           | Hub does                                                  |
| ----------------------------------------------------- | --------------------------------------------------------- |
| 200                                                   | Remembers the counts and timestamp it sent                |
| 410, `BadDeviceToken`, `ExpiredToken`, `Unregistered` | Drops the Live Activity token, keeps the device           |
| 429 `TooManyRequests`                                 | Backs off that device for a minute, then sends the latest |
| 5xx, timeout                                          | One retry after 5 seconds, then waits for the next change |

Updates are perishable like alerts: no backlog; only the latest counts matter.

## Versions

| Combination                        | What happens                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| Hub without `liveActivities`       | No token is requested or sent; cards are local, "Out of date" when suspended |
| Hub with it, node without counts   | The token is registered; nothing is sent until a node signals                |
| Older app, newer Hub               | Never sends a token; nothing changes                                         |
| Build without push (Personal Team) | No token; the card is local                                                  |

## Testing

The simulator shows Live Activities and takes local updates, but it has no APNs token for a
Live Activity, so push updates need a real iPhone on a build signed by a paid team with the push
entitlement, and a Hub that advertises `liveActivities`. With such a build, a card started while
the Hub is registered logs its token registration; a `liveactivity` push sent to that token with
the counts above must change the card while Ryco is suspended, and an `end` must remove it.
