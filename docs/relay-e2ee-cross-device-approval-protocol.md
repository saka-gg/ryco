# Relay E2EE cross-device approval protocol

Status: protocol version 1.

This protocol makes first-time native-client verification a one-scan flow without making the Hub
a trust anchor. It supplements, and does not replace, the pairing-only handshake and the durable
node-side client-authorization record defined by `docs/relay-e2ee-protocol.md`.

## 1. Security result

The owner first lets the new device complete the existing pairing-only attempt. That attempt proves
the device's P-256 client identity to the node and creates a pending authorization record. On a
locally trusted owner surface, the owner approves that exact pending record. Only after the approval
is durable may the node sign a short-lived cross-device approval attestation and display it as a QR
code.

The new device scans the QR and verifies, locally, that:

1. the Ed25519 signature is by the node identity currently presented for its selected node;
2. the Hub origin, account id, node id, continuity id, and policy generation match that selection;
3. the attested client fingerprint is the fingerprint of this device's hardware-backed P-256 key;
4. the attestation is canonical, bounded, and current; and
5. the attested role and capability set are valid canonical relay authority.

Only then may it atomically promote the presented node identity to a verified local pin. It derives
the safety number locally from the two public keys; the safety number never appears in the QR.

A fresh ticket, relay channel, and IK handshake are still required before application traffic.
The node re-reads its durable authorization at that handshake. The QR is therefore an attestation,
not a bearer credential: copying it cannot authorize another key, and replay after revocation cannot
open a channel.

## 2. Threat boundary and unavoidable owner action

Account login alone cannot safely verify a new device when the Hub is in the E2EE threat model. A
Hub can copy account-scoped data and substitute its own first-contact node key. The out-of-band scan
from a node-controlled, already trusted owner surface is the trust anchor for a new phone.

The Hub may observe or replay public attestation bytes. It cannot forge the node signature, change
the client fingerprint, or complete IK without the attested client's private key. The node does not
serve the QR through a peer-controlled handshake and does not treat a QR scan as authorization.

## 3. Ceremony

1. The new native client creates or loads its hardware-backed P-256 identity.
2. It performs the existing pairing-only attempt. No project, conversation, file, terminal, or
   other application data is sent.
3. The node commits the pending record under `(hubOrigin, accountId, clientFingerprint)`.
4. The owner selects that record on a locally trusted node or Desktop security surface, compares the
   displayed device details, and approves it at the role the device connects with (the node CLI's
   `--max-role` can name another).
5. The node commits the approved record and completes any authorization sweep before acknowledging.
6. The owner asks the node to display an approval QR for that exact approved record.
7. The node reads the record again, reads its active identity/continuity/policy descriptor, creates
   and signs the attestation below, and displays its encoded envelope.
8. The new client scans and verifies the envelope against its current selection, presented signed
   statement, and own P-256 public key.
9. It promotes the pin and device-level verified marker in one durable trust-store write. The
   approval time stored in the record is the attested node approval time; the downgrade latch is set
   at the local scan decision time.
10. The client discards the QR bytes and reconnects with a fresh ticket/channel/IK handshake.

QR generation is repeatable while the record remains approved; every generated attestation has a
fresh random id and short lifetime. Revoked, pending, missing, mismatched, or stale records cannot
produce one.

## 4. Canonical transcript

All integers are non-negative safe integers. All byte strings have their exact protocol lengths.
The to-be-signed value is the following canonical-CBOR definite-length array:

```text
[
  "ryco.e2ee.cross-device-approval.v1",
  1,
  hubOrigin,
  accountId,
  nodeId,
  "ed25519",
  nodeIdentityPublicKey,
  clientIdentityFingerprint,
  maxRole,
  canonicalCapabilitySet,
  nodeContinuityId,
  nodePolicyGeneration,
  approvedAt,
  approvalId,
  issuedAt,
  expiresAt,
]
```

`approvalId` is 32 random bytes. `clientIdentityFingerprint` is the raw 32-byte
`ryco.client-key.v1` fingerprint already used as the node authorization key. `expiresAt` must be
strictly later than `issuedAt` and no more than 300,000 milliseconds later. Receipt permits at most
30,000 milliseconds of clock skew. The complete TBS is bounded to 1,024 bytes so every accepted
transcript can be represented by the required medium-error-correction QR.

The signed envelope is the canonical-CBOR array:

```text
[
  "ryco.e2ee.cross-device-approval-envelope.v1",
  1,
  tbs,
  nodeEd25519Signature,
]
```

The envelope is encoded as unpadded base64url and prefixed with
`ryco-e2ee-approval-v1:` for the QR payload. The full decoded envelope is bounded to 1,200 bytes;
its prefixed base64url form therefore fits a version-40 QR at medium error correction. Decoders
re-encode and byte-compare both arrays, rejecting alternate representations.

## 5. Binding and freshness rules

The verifier recomputes the node and client fingerprints from validated public keys. It requires
exact equality with the currently selected Hub/account/node, the currently presented node public
key, continuity id, and policy generation, and the local client's current identity key. It accepts
neither a previous statement generation nor an attestation for another approved client.

`approvedAt <= issuedAt < expiresAt` is required. The current-time check is
`issuedAt <= now + 30s` and `expiresAt > now - 30s`. A successful scan is not proof that the record
is still approved; only the subsequent fresh IK authorization read establishes that fact.

## 6. Storage and logging

The node does not store generated attestations or approval ids. The client does not persist QR
payloads or signatures. Neither side logs them. The durable state remains the node authorization
record and the client's verified pin/latch document.
