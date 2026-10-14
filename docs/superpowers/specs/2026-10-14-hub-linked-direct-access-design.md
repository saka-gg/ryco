# Hub-linked direct access design

Status: implemented (server, Desktop). Extends `2026-09-04-automatic-account-native-e2ee-design.md`; see "Relationship to
earlier decisions" for the one non-goal it revisits.

## Summary

A native client that already holds a trusted Hub relay channel to a node — `account-enrolled` or
`locally-verified` native E2EE — can ask that node, over that channel, for a direct (LAN or Tailscale)
credential. The node issues a short-lived, one-time pairing code bound to the channel's device and
role, plus the node's direct environment id and reachable endpoints. The client redeems the code
directly at the node exactly like a pasted pairing link today, and stores the resulting bearer session
as a normal saved environment.

The owner no longer creates or copies a pairing link for their own signed-in devices. The Hub never
sees the code or the bearer: both travel only inside the E2EE channel or on the direct connection.
The Hub needs no change.

## Motivation

After automatic account-enrolled native E2EE, a signed-in Desktop reaches every authorized node
through the Hub with no approval step. Direct access — lower latency on the same network, and access
while the Hub is unreachable — still requires the owner to run `ryco auth pairing create` or use
Settings → Connections on the node, then paste the link on each device. That is the per-device
ceremony account trust removed for the relay path.

## Relationship to earlier decisions

The account-enrolled design lists "Allowing an account grant on a direct, non-Hub transport" as a
non-goal. This design keeps that rule: a `HubDeviceGrant` is never presented to, or accepted by, a
direct endpoint. What changes is a narrower invariant documented in `apps/server/src/auth/http.ts`
and `ServerAuth.rotateBearerSession`: "a relay or hosted client can never mint or extend a direct
credential". After this change a relay client can mint one, but only:

- over an established native E2EE channel (`account-enrolled` or `locally-verified`), never Web NX,
  legacy plaintext, or a direct connection;
- bounded by that channel's effective role, never `direct_owner` local-access management;
- tied to the device's enrollment or local authorization so either revocation removes it;
- with a lifetime that forces periodic renewal through the relay.

Rotation over the direct listener still cannot extend a linked credential past its bound.

## Threat model

The relay channel already authorizes the device at its effective role; the direct credential grants
nothing the channel did not. The new exposures, and their bounds:

| Exposure                                 | Bound                                                                                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Hub or account compromise                | Already able to enroll a device and reach the node over the relay at the same role (the account-enrolled trade-off); gains only a second path. |
| Revocation while the node is off the Hub | The node misses `e2ee.enrollment-revoked`; the linked session still expires within `LINKED_SESSION_MAX_AGE` (7 days) without relay renewal.    |
| Bearer interception on plain-HTTP LAN    | Same as today's pasted pairing links; Tailscale or Tailscale Serve endpoints are preferred when advertised.                                    |
| Pairing code leakage                     | Single use, 2-minute TTL, never leaves the E2EE channel, bound to the issuing channel's device.                                                |
| Escalation to local access management    | Linked sessions never carry `canManageLocalAccess`; they cannot create pairing links, list or revoke clients, or issue more linked access.     |

Locally verified nodes and the strongest node policy are unaffected: a node in
`require-locally-approved-native-e2ee` issues linked access only to `locally-verified` channels.

## Design

### 1. Relay authority reaches the RPC layer

A relay `RpcPrincipal` used to carry only the Hub-asserted role and channel id; the E2EE trust source
lived inside `NodeE2eeChannelSession`. Relay principals now carry a lazily read `relayAuthority()`
(`apps/server/src/ws/RpcPrincipal.ts`), set at row N3 from the same snapshot the session registers
and cleared when the session leaves the directory (`HubConnectorLive`):

```ts
type RelayChannelAuthority =
  | {
      readonly trustSource: "account-enrolled";
      readonly enrollmentId: string;
      readonly clientIdentityFingerprint: Uint8Array;
      readonly role: RpcPrincipalRole;
    }
  | {
      readonly trustSource: "locally-verified";
      readonly clientIdentityFingerprint: Uint8Array;
      readonly role: RpcPrincipalRole;
    }
  | { readonly trustSource: "none" };
```

`role` is the lower of the channel's role and the device's own ceiling (the grant's maximum role, or
the approved record's `maxRole`). Web NX, legacy plaintext, a handshake not yet at N3, a channel that
is no longer in mode `e2ee`, and an unknown role all read as `none`
(`apps/server/src/hubConnector/relayChannelAuthority.ts`).

### 2. `auth.issueLinkedDirectAccess` RPC

A new access class, `relay_native`, admits only relay principals whose authority is not `none`. A
client cannot see the trust source, so `hostedRoleAllows` treats the class as callable and leaves the
decision to the node. The handler (`apps/server/src/auth/linkedDirectAccess.ts`):

1. Re-reads the authority; a lease that ended in between answers `403`.
2. Keeps the node's advertised endpoints another device could use — never loopback or an endpoint
   marked unavailable — most private first (Tailscale HTTPS, then Tailscale, then LAN). With none it
   answers `{ kind: "unavailable", reason: "no-direct-endpoint" }`.
3. Issues a one-time pairing code through `BootstrapCredentialService` with a 2-minute TTL, subject
   `hub-linked`, the label `Linked through Hub · <device label>`, and a `link`: trust source,
   enrollment id (account-enrolled only), base64url client fingerprint, and the authority's role.
4. Answers `{ kind: "issued", environmentId, label, endpoints, credential, expiresAt }`, where
   `environmentId` is the node's direct environment id (distinct from its Hub environment id).

A linked code is never listed or published as an owner pairing link, and it redeems only as a bearer
(`/api/auth/bootstrap/bearer`): the cookie exchange refuses it. Asking again issues another code; an
unused one simply expires.

### 3. Linked sessions on the node

Migration 090 adds `link_trust_source`, `link_enrollment_id`, `link_client_fingerprint`, and
`link_role` to `auth_pairing_links` and `auth_sessions` (NULL for every existing row). Redeeming a
linked code copies its link onto the session; the session's own `role` stays `client`, so every
owner-only HTTP route keeps refusing it.

`directRpcPrincipal` maps a linked session to `{ transport: "direct", role: link.role,
canManageLocalAccess: false }`. A linked session expires `LINKED_SESSION_MAX_AGE` (7 days) after issue,
and bearer rotation never carries its chain past that, so rotation of a linked session is always
refused with `renewal-limit`. It renews only by asking the node again over the relay.

Revocation (`SessionCredentialService.revokeLinked`):

- `e2ee.enrollment-revoked`, already delivered to `HubConnectorLive`, also revokes every linked
  session with that enrollment id.
- Narrowing, revoking, or purging a local client authorization (`NodeE2eeOperator`) revokes linked
  sessions with that client fingerprint.
- Owners see linked sessions in Settings → Connections labelled `Linked through Hub · <device>` and
  can revoke them like any other client.

### 4. Desktop client

The direct environment is a separate environment with its own id. Until a machine can be routed over
either path, adding it shows the machine a second time with its threads listed twice. Linking is
therefore an explicit action rather than automatic:

- Settings → Hub → Workspace machines offers **Add direct access** on every online remote machine with
  `account-trusted` or `verified` trust that has no linked direct environment.
- The action (`apps/web/src/platform/desktopHubLinkedDirectAccess.ts`) calls the RPC over the machine's
  relay connection, probes each returned endpoint's `/.well-known/ryco/environment` with a 3-second
  timeout, keeps the first that answers with the issued environment id, and redeems the code through
  the existing `addSavedEnvironment` flow with a `hubLink: { hubEnvironmentId, linkedAt }` on the
  record.
- A machine the user already paired by hand (a saved record for that direct id without `hubLink`) is
  never replaced.
- The row then reads `… · Direct access ready`.
- Each time Desktop connects to a linked machine over the relay and the link is three days old or
  more, it links again in the background, well within the node's seven days. A failed renewal waits
  15 minutes before the next connect retries.

`hubLink` is part of the persisted saved-environment record on every store; the shared
`persistedSavedEnvironmentRecordFields` (`@ryco/shared/savedEnvironmentRecord`) copies the persisted
fields in one place.

The saved-environment supervisor used to disconnect every `kind: "saved"` connection missing from the
registry, including Desktop's relay connections registered with placeholder URLs; a registry write
from this flow dropped them. It now skips `hub-hosted` connections.

### 5. CLI and mobile

The CLI has no persistent Hub client session, so `ryco remote` keeps pasted pairing links. A later
`ryco remote add --via-hub <machine>` needs a CLI Hub client and relay client first. Mobile can adopt
the same flow through the shared `@ryco/client-runtime/connection` helpers
(`hubLinkedDirectAccessDue`, `resolveHubLinkedDirectTarget`) once its direct plane consumes saved
environments the same way.

## Failure behavior

| Situation                            | Behavior                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| Node too old (no RPC)                | The action reports a failure; relay access is unaffected                       |
| No direct endpoint                   | Reported as loopback-only; nothing is saved                                    |
| No endpoint answers from here        | Reported as unreachable; nothing is saved                                      |
| Web NX, legacy, or direct caller     | Rejected by the `relay_native` access class                                    |
| Enrollment revoked                   | Node revokes linked sessions; the saved environment asks to pair again         |
| Hub unreachable for more than 7 days | Direct access expires; the next relay connection to the machine links it again |

## Testing

- Server: migration 090 and its repair; linked grants persist into sessions, are never listed, and
  never become cookies; linked principal role and `canManageLocalAccess: false`; the 7-day bound and
  refused rotation; revocation by enrollment and by client key; relay authority and role
  intersection; the `relay_native` class; the operator withdrawal hook; endpoint ordering.
- Client runtime / Desktop: due and hand-paired checks; endpoint probing, environment-id check, and
  probe timeout; linking outcomes; renewal only of aged links; `hubLink` persistence round trip; the
  supervisor keeps relay connections on registry writes.
- End to end (manual): Desktop signed in, the M4 CLI node on the same network; **Add direct access**
  creates a working direct environment without a pairing link; revoking the device on the Hub ends
  it.

## Follow-ups

1. Route one machine over either path: merge the Hub and direct environment ids so linking can become
   automatic.
2. CLI `ryco remote add --via-hub`.
3. Mobile.
