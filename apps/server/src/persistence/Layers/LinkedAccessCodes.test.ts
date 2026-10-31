import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Duration, Effect, Layer } from "effect";

import { ServerConfig } from "../../config.ts";
import { BootstrapCredentialServiceLive } from "../../auth/Layers/BootstrapCredentialService.ts";
import { BootstrapCredentialService } from "../../auth/Services/BootstrapCredentialService.ts";
import { makeLinkedAccessCodes } from "./LinkedAccessCodes.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = BootstrapCredentialServiceLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "ryco-linked-codes-test-" })),
);

it.layer(NodeServices.layer)("LinkedAccessCodes", (it) => {
  it.effect(
    "lists and revokes a device's unredeemed linked codes, narrowed like its sessions",
    () =>
      Effect.gen(function* () {
        const bootstrap = yield* BootstrapCredentialService;
        const codes = yield* makeLinkedAccessCodes;
        const issueLinked = (input: {
          readonly enrollmentId: string | null;
          readonly clientFingerprint: string;
          readonly accountId?: string;
        }) =>
          bootstrap.issueOneTimeToken({
            ttl: Duration.minutes(2),
            subject: "hub-linked",
            link: {
              trustSource: input.enrollmentId === null ? "locally-verified" : "account-enrolled",
              enrollmentId: input.enrollmentId,
              clientFingerprint: input.clientFingerprint,
              role: "operator",
              ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
            },
          });
        const laptop = yield* issueLinked({
          enrollmentId: "enr_laptop",
          clientFingerprint: "fp-laptop",
          accountId: "acct_1",
        });
        const phone = yield* issueLinked({
          enrollmentId: "enr_phone",
          clientFingerprint: "fp-phone",
        });
        const local = yield* issueLinked({ enrollmentId: null, clientFingerprint: "fp-laptop" });
        const redeemed = yield* issueLinked({
          enrollmentId: "enr_desk",
          clientFingerprint: "fp-desk",
        });
        yield* bootstrap.consume(redeemed.credential);
        // An owner's pasted pairing code has no link and is never listed here.
        const pasted = yield* bootstrap.issueOneTimeToken();

        expect(
          (yield* codes.listPending())
            .map((link) => [link.clientFingerprint, link.accountId])
            .toSorted(),
        ).toEqual([
          ["fp-laptop", undefined],
          ["fp-laptop", "acct_1"],
          ["fp-phone", undefined],
        ]);

        // Another account's code of the same key stays; so does the key's locally verified code.
        expect(
          yield* codes.revoke({
            clientFingerprint: "fp-laptop",
            trustSource: "account-enrolled",
            accountId: "acct_2",
          }),
        ).toBe(0);
        expect(
          yield* codes.revoke({
            clientFingerprint: "fp-laptop",
            trustSource: "account-enrolled",
            enrollmentId: "enr_laptop",
            accountId: "acct_1",
          }),
        ).toBe(1);
        expect(yield* codes.revoke({ enrollmentId: "enr_phone" })).toBe(1);
        // A redeemed code is spent already; its session is revoked on its own.
        expect(yield* codes.revoke({ clientFingerprint: "fp-desk" })).toBe(0);

        for (const code of [laptop, phone]) {
          const refused = yield* Effect.flip(bootstrap.consume(code.credential));
          expect(refused.message).toContain("no longer available");
        }
        yield* bootstrap.consume(local.credential);
        yield* bootstrap.consume(pasted.credential);
        expect(yield* codes.listPending()).toEqual([]);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "revokes every unredeemed linked code, and no other code, when the Hub revokes the node",
    () =>
      Effect.gen(function* () {
        const bootstrap = yield* BootstrapCredentialService;
        const codes = yield* makeLinkedAccessCodes;
        const enrolled = yield* bootstrap.issueOneTimeToken({
          ttl: Duration.minutes(2),
          subject: "hub-linked",
          link: {
            trustSource: "account-enrolled",
            enrollmentId: "enr_laptop",
            clientFingerprint: "fp-laptop",
            role: "owner",
            accountId: "acct_1",
          },
        });
        const local = yield* bootstrap.issueOneTimeToken({
          ttl: Duration.minutes(2),
          subject: "hub-linked",
          link: {
            trustSource: "locally-verified",
            enrollmentId: null,
            clientFingerprint: "fp-desk",
            role: "viewer",
          },
        });
        // The owner's own pairing links (a pasted code, an owner code) have no link.
        const pasted = yield* bootstrap.issueOneTimeToken();
        const ownerCode = yield* bootstrap.issueOneTimeToken({ role: "owner" });

        expect(yield* codes.revoke({ allLinks: true })).toBe(2);
        for (const code of [enrolled, local]) {
          const refused = yield* Effect.flip(bootstrap.consume(code.credential));
          expect(refused.message).toContain("no longer available");
        }
        yield* bootstrap.consume(pasted.credential);
        yield* bootstrap.consume(ownerCode.credential);
        expect(yield* codes.revoke({ allLinks: true })).toBe(0);
      }).pipe(Effect.provide(layer)),
  );
});
