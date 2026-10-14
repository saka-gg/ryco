import type { AuthPairingLink, ServerAuthBootstrapMethod } from "@ryco/contracts";
import { Data, DateTime, Duration, Context } from "effect";
import type { Effect, Stream } from "effect";

import type { AuthAccessLink } from "../../persistence/Services/AuthAccessLink.ts";

export type BootstrapCredentialRole = "owner" | "client";

export interface BootstrapGrant {
  readonly method: ServerAuthBootstrapMethod;
  readonly role: BootstrapCredentialRole;
  readonly subject: string;
  readonly label?: string;
  readonly expiresAt: DateTime.DateTime;
  /** Present for a grant issued over a trusted relay channel; its session inherits it. */
  readonly link?: AuthAccessLink;
}

export class BootstrapCredentialError extends Data.TaggedError("BootstrapCredentialError")<{
  readonly message: string;
  readonly status?: 401 | 500;
  readonly cause?: unknown;
}> {}

export interface IssuedBootstrapCredential {
  readonly id: string;
  readonly credential: string;
  readonly label?: string;
  readonly expiresAt: DateTime.Utc;
}

export type BootstrapCredentialChange =
  | {
      readonly type: "pairingLinkUpserted";
      readonly pairingLink: AuthPairingLink;
    }
  | {
      readonly type: "pairingLinkRemoved";
      readonly id: string;
    };

export interface BootstrapCredentialServiceShape {
  readonly issueOneTimeToken: (input?: {
    readonly ttl?: Duration.Duration;
    readonly role?: BootstrapCredentialRole;
    readonly subject?: string;
    readonly label?: string;
    /**
     * Hub-linked direct access. A linked grant is never listed or published as
     * an owner pairing link: it exists only for the device that asked for it.
     */
    readonly link?: AuthAccessLink;
  }) => Effect.Effect<IssuedBootstrapCredential, BootstrapCredentialError>;
  readonly listActive: () => Effect.Effect<
    ReadonlyArray<AuthPairingLink>,
    BootstrapCredentialError
  >;
  readonly streamChanges: Stream.Stream<BootstrapCredentialChange>;
  readonly revoke: (id: string) => Effect.Effect<boolean, BootstrapCredentialError>;
  readonly consume: (credential: string) => Effect.Effect<BootstrapGrant, BootstrapCredentialError>;
}

export class BootstrapCredentialService extends Context.Service<
  BootstrapCredentialService,
  BootstrapCredentialServiceShape
>()("ryco/auth/Services/BootstrapCredentialService") {}
