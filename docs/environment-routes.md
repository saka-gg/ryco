# One machine over several routes

A machine on the Hub can also be reachable directly: over Tailscale, the LAN, or a public address.
The goal is one machine with one identity, reached over the best route that answers, moving back to
a faster route when it becomes reachable again. Today a linked direct grant creates a second
environment with its own id, so the machine and its threads show twice, and nothing switches routes.

This page is the design. Phase 1, the route model and its policy, is in
`packages/client-runtime/src/connection/environmentRoutes.ts`; the upgrade loop is
`environmentRouteUpgrader.ts`; the walk each attempt makes over a machine's linked routes is
`hubLinkedRoutes.ts`. Phase 2 (Desktop) and phase 3 (the phone) use them.

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
- The grant names the node identity key that relay channel's handshake verified. Before a client
  redeems the grant's code or presents its bearer at a direct address, it posts a fresh random
  challenge and the origin it contacted to `/.well-known/ryco/environment/identity`; the node
  signs `["ryco.direct-route-identity.proof.v1", directEnvironmentId, origin, challenge]` with that
  key (`@ryco/shared/directRouteIdentity`), and only for an origin it advertises right now. An
  address that cannot answer gets nothing and is held until the link is renewed over the relay (a
  rotated key, or the machine's new addresses, arrive that way). A link from a node older than the
  proof names no key, so it is never used and is renewed instead.
- The origin is what keeps a reused address from borrowing the machine's answer: a device that now
  holds an address the machine had (a Tailscale or DHCP address given to another device, a host or
  tunnel name handed on) can pass the challenge through, or redirect it, to the machine, but the
  machine no longer advertises that origin and signs nothing; rewriting the origin gets a
  signature for another origin, which the client's own check refuses.
- The proof endpoint needs no credential, so it never takes the identity lock or starts identity
  repairs (only the process that already owns the identity answers), and it is paced per remote
  address under one ceiling for all.

### Why direct routes still need HTTPS or Tailscale

The proof shows that the machine holding the key answers for the origin the client contacted, now.
It cannot show that nobody sits between the client and that origin: the socket that follows is not
bound to the key, so on plain HTTP someone on the network can sit in front of the machine's own
address, pass the challenge through, then read and change everything after it, bearer included. Only an encrypted channel tied to the key (the relay's E2EE, or the same
E2EE over the direct socket) would close that. HTTPS and Tailscale close it at the transport: the
certificate names the host, WireGuard the peer. So the two checks are complementary:

- the transport rules out someone in between;
- the proof, bound to the origin, rules out the wrong machine at the end: an address that now
  belongs to another device (a reused Tailscale or DHCP address, a renamed host with a valid
  certificate, a tunnel name handed to someone else), or another node serving a copy of the public
  descriptor.

Plain LAN and public addresses therefore stay out, and linking no longer redeems a code at one.
Running the relay's E2EE over the direct socket would let them in; it is not built.

## Routes

| Kind   | Reach                                       | Credential                                     |
| ------ | ------------------------------------------- | ---------------------------------------------- |
| direct | `tailnet-https`, `tailnet`, `lan`, `public` | the linked bearer (4 days, renewed over relay) |
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

On the phone the hosted attempt factory (`HostedRelayAttemptFactory`) stays the one lifecycle owner
of a Hub machine's connection. Its binding gains two native-only ports, `resolveDirectRoute` and
`createDirectSocket`; the hosted browser binds neither and takes exactly the relay path it took
before. A direct attempt is an attempt like any other: it starts after the same admission checks,
is fenced by the session generation, publishes its role when its socket opens (the linked
session's role, which the node reports in `GET /api/auth/session` as `linkedRole`, since no relay
reports one there), and is ready only after its own fresh shell snapshot. A relay refusal holds
every direct route until a relay socket opens again.

## Phases

1. The route model and policy in client-runtime, pure and tested (this change), plus the mobile
   `network-changed` signal (#924).
2. Desktop (done):
   - the saved catalog keeps `hubLink` records apart (`linkedById`): they are routes of the Hub
     environment, never environments, so nothing lists or connects them, and what an earlier run
     kept under the direct id is dropped once;
   - linking again rewrites the stored address and bearer in place and asks the machine's
     connection to check its routes;
   - only addresses whose transport proves which machine answers may carry a Hub machine: HTTPS
     (the certificate names the host) or a Tailscale address (WireGuard names the peer). A plain
     LAN or public address never does: anyone on that network could answer with the machine's
     public descriptor and collect the linked bearer, while the relay is end-to-end encrypted with
     a pinned identity. Since the identity proof (above), each route also proves the key before
     the bearer goes there;
   - the Hub connection's socket factory walks the routes on every attempt
     (`apps/web/src/platform/desktopHubLinkedRoutes.ts`): linked addresses are checked in
     parallel, the best one that answers as the machine's direct id and proves its identity key
     gets a one-time socket token from the linked bearer, else the relay Desktop main owns;
   - a relay refusal (authorization withdrawn, not verified, update required) blocks every direct
     route and upgrade until a relay socket opens again: no route goes around the Hub's verdict;
   - a refused bearer holds its address until the link changes (no timer) and asks for a renewal
     over the relay;
   - while on the relay, better routes are checked every minute, when the network comes back and
     when the window is shown, and a new attempt is made when one answers; each check on the relay
     also renews a link that is due;
   - a link older than three days is not used, so the relay carries the machine and renews it;
   - a linked session's work has the same owner as the device's relay channel, so a Git action
     survives a route switch;
   - Hub settings offer "Remove direct access"; signing out of the Hub (or another account)
     forgets every link and its bearer; linking a machine again replaces an older link under
     another direct id.
   - Not done: an upgrade drops the open socket before the new route has proven itself (turns
     run on the node and resume, but in-flight requests fail and retry); a linked session keeps
     the role it was linked with until it is renewed.
3. Mobile (done):
   - a Hub machine's row offers "Add direct access" while its relay session is ready, and
     "Remove direct access" once linked; the phone asks over the relay, proves the address's
     identity key and saves the link apart from environments, exactly as Desktop does;
   - every attempt of the machine's hosted connection walks its linked routes first
     (`apps/mobile/src/hostedHub/linkedDirectAccess.ts`), then the relay;
   - while on the relay, better routes are checked every minute, on a network change and on
     resume, and an aged link is renewed there; removing a link moves a connection on it back to
     the relay at once;
   - signing out of the Hub, or another account, forgets every link and its bearer;
   - the row says "Direct" while the machine's latest attempt took a direct route.
4. Optionally, the node pushes its direct endpoints in its config, and Desktop mode includes
   MagicDNS.
