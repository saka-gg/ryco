# Hub-linked direct access, kept in step with the Hub

A device linked through the Hub (`auth.issueLinkedDirectAccess`, see
[environment-routes.md](environment-routes.md)) holds a direct bearer on the node. The node records
the link: the device's trust source, Hub enrollment, client key fingerprint, Hub account and the
relay channel's role at the time. A linked session lives at most 4 days, and at most 24 hours for a
locally verified device (a key the node's owner approved on the node, never enrolled through the Hub),
which the Hub cannot answer for. Both caps count from when the device linked and apply on every
check, so a longer link an earlier node issued ends at them too. A client whose link the node refuses
falls back to the relay and links again there.

When a Hub owner removes a member's grant on the machine or changes their role, or the member's
account, device or Hub session ends, the node revokes or narrows that member's linked sessions:

| When                                                         | What the node does                                     |
| ------------------------------------------------------------ | ------------------------------------------------------ |
| A device opens a relay channel at a lower role               | Revokes its links above that role                      |
| The Hub closes a device's relay channel with `grant_revoked` | Revokes that device's links at once, then asks the Hub |
| The Hub closes a device's relay channel with `revoked`       | Asks the Hub (`revoked` also covers a Hub sign-out)    |
| The Hub sends `node.linked-access.changed`                   | Asks the Hub                                           |
| The connector comes online                                   | Asks the Hub (within 10 s, spread across nodes)        |
| Every 15 minutes while any linked session stands             | Asks the Hub                                           |
| The Hub sends `e2ee.enrollment-revoked`                      | Revokes that enrollment's links at once (as before)    |
| The Hub refuses the node's connection as revoked             | Revokes every linked session and unredeemed code       |

A node the Hub revoked (a relay `error` with `revoked` or `node_revoked`, which puts the connector
in its terminal `revoked` state) can no longer ask about its links, so it ends all of them, of either
trust source, each time it enters that state. Only sessions and codes with a link are touched: the
owner's own sessions and pairings made by hand stay. A failure the connector retries never does
this. Devices link again over the relay once the node is enrolled again.

The Hub sends `node.linked-access.changed` only on a node connection whose relay auth listed the
`linked-access-check` feature ([relay-protocol.md](relay-protocol.md)), so an older node never
receives a frame type it does not know. Revoking a device's links also revokes its unredeemed linked
codes, so a code issued just before cannot link it again.

## The question

`POST /api/node/linked-access/check`, with a fresh node proof (`@ryco/contracts/node-linked-access`).
The node lists up to 64 account-enrolled devices: account (absent for links made before nodes kept
it), enrollment and client key fingerprint. Locally verified devices are not the Hub's to judge and
are never sent. The Hub answers one status per device, in order, about the proving node only:

- `active` with a role: a relay channel from this device would be admitted now, at that role. The
  node revokes the device's sessions linked above it. It never raises a role or extends a session
  from an answer; a promoted member gets the new role at their next link.
- `withdrawn`: a channel would be refused (grant, membership, account, enrollment or Hub session gone,
  or the key replaced). The node revokes the device's links.
- `unknown`: the Hub cannot tell. The node keeps the links to their 4 days.

Locally verified devices are never asked about. Their links end at 24 hours, when the node owner
withdraws the device's local authorization, and when the device opens a relay channel at a lower
role. That role is the Hub's current grant for the channel intersected with the device's own
ceiling, as for any channel; links of either trust source above it end, under the channel's own
enrollment and account when it names one. Nothing is ever raised: a promoted member gets the new
role at their next link. A locally verified link records no account, so on an install where two Hub
accounts share one device key, a channel of the lower-role account also narrows the other account's
locally verified link (it links again at its own role).

An answer whose length does not match the question is ignored. A Hub that answers 404 predates the
route: the node asks again only after its next connect, and the 4-day limit still applies.

Checks run one at a time, at least 30 seconds apart; a nudge during a check starts another after it,
so a stale answer is never the last one. Each question (up to 64 devices) spends one node-proof
challenge. Devices whose linked code is not redeemed yet are asked about too, and revoking a device's
links also revokes its unredeemed codes.
