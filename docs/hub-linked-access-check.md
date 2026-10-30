# Hub-linked direct access, kept in step with the Hub

A device linked through the Hub (`auth.issueLinkedDirectAccess`, see
[environment-routes.md](environment-routes.md)) holds a direct bearer on the node. The node records
the link: the device's trust source, Hub enrollment, client key fingerprint, Hub account and the
relay channel's role at the time. A linked session lives at most 4 days.

When a Hub owner removes a member's grant on the machine or changes their role, or the member's
account, device or Hub session ends, the node revokes or narrows that member's linked sessions:

| When                                                         | What the node does                                     |
| ------------------------------------------------------------ | ------------------------------------------------------ |
| The Hub closes a device's relay channel with `grant_revoked` | Revokes that device's links at once, then asks the Hub |
| The Hub closes a device's relay channel with `revoked`       | Asks the Hub (`revoked` also covers a Hub sign-out)    |
| The Hub sends `node.linked-access.changed`                   | Asks the Hub                                           |
| The connector comes online                                   | Asks the Hub (within 10 s, spread across nodes)        |
| Every 15 minutes while any linked session stands             | Asks the Hub                                           |
| The Hub sends `e2ee.enrollment-revoked`                      | Revokes that enrollment's links at once (as before)    |

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

An answer whose length does not match the question is ignored. A Hub that answers 404 predates the
route: the node asks again only after its next connect, and the 4-day limit still applies.

Checks run one at a time, at least 30 seconds apart; a nudge during a check starts another after it,
so a stale answer is never the last one. Each question (up to 64 devices) spends one node-proof
challenge. Devices whose linked code is not redeemed yet are asked about too, and revoking a device's
links also revokes its unredeemed codes.
