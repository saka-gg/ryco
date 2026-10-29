# One machine over several routes

A machine on the Hub can also be reachable directly: over Tailscale, the LAN, or a public address.
The goal is one machine with one identity, reached over the best route that answers, moving back to
a faster route when it becomes reachable again. Today a linked direct grant creates a second
environment with its own id, so the machine and its threads show twice, and nothing switches routes.

This page is the design. Phase 1, the route model and its policy, is in
`packages/client-runtime/src/connection/environmentRoutes.ts`. Nothing uses it yet.

## Identity

- The canonical id stays the Hub id. A linked direct grant does not create a second environment;
  it adds routes to the first.
- A direct route records the machine's own direct id (`expectedDescriptorId`).
  - Before any credential is sent, the route's public descriptor
    (`/.well-known/ryco/environment`) must answer with exactly that id.
  - The connection then presents the canonical id, as a `hub-hosted` connection already does.
- The only proof that a direct id and a Hub id are the same machine is the linked direct grant,
  issued over the E2EE relay. A public descriptor proves nothing on its own, so a route is never
  learned from one.

## Routes

| Kind   | Reach                                       | Credential                                     |
| ------ | ------------------------------------------- | ---------------------------------------------- |
| direct | `tailnet-https`, `tailnet`, `lan`, `public` | the linked bearer (7 days, renewed over relay) |
| relay  | —                                           | the relay's own E2EE session and tickets       |

- Order: tailnet HTTPS, tailnet, LAN, public, then the relay. Routes of one reach keep their order.
- Credentials never cross route kinds. The linked bearer is node-wide, so every direct address of
  the machine shares it.
- Sources:
  - `linked`: from the grant.
  - `learned`: from the machine's advertised endpoints, read again on each relay connect.
  - `user`: added by hand.
- Only learned routes are replaced automatically. A learned route the machine stops reporting is
  dropped.

## Choosing and upgrading

- Direct routes are checked in parallel, 2.5 s each. The best one that answered as the machine
  wins; otherwise the relay.
- Switching routes is a new socket attempt. Readiness and mutation authority reset and wait for a
  fresh shell snapshot, as after any reconnect. Relay attempts are still created and fenced by the
  hosted lifecycle owner; the route layer only picks which attempt to make.
- While on a worse route, better routes are checked every 60 s, and at once on `network-changed`
  or resume. One check runs at a time.
- An upgrade that lands elsewhere holds its target back for 5 minutes.

## Who uses it

Only native clients use routes: Desktop and the mobile app. The hosted browser keeps its single
relay lifecycle owner and never sees a route. `canAdoptHostedEnvironmentSession` is unchanged.

## Phases

1. The route model and policy in client-runtime, pure and tested (this change), plus the mobile
   `network-changed` signal (#924).
2. Desktop:
   - fold saved `hubLink` records into the Hub environment's routes, and drop the duplicate
     environment and its cached data;
   - renew the linked bearer in place;
   - walk routes inside the connection's attempt factory.
3. Mobile: ask for linked direct access over the relay through the shared helpers. Its adapter
   only supplies network changes.
4. Optionally, the node pushes its direct endpoints in its config, and Desktop mode includes
   MagicDNS.
