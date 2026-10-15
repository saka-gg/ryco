/**
 * THE NATIVE LEG OF THE §16 FIXTURE CORPUS.
 *
 * TEST SUPPORT ONLY. Nothing in a shipped code path may import this module.
 *
 * docs/relay-e2ee-protocol.md §14.7: the corpus must pass with the native
 * implementations installed as well as absent. A corpus suite's native leg
 * calls {@link installCountedE2eeNodeNativePrimitives} before it loads the
 * suite, so every module the suite reaches resolves the installed provider,
 * then checks through `used()` that the suite actually answered through it.
 */
import { type E2eeNativePrimitives, installE2eeNativePrimitives } from "./relayE2eeKeys.ts";
import { makeE2eeNodeNativePrimitives } from "./relayE2eeNodeCrypto.ts";

export type E2eeNativePrimitiveName = "x25519" | "ed25519" | "p256" | "chacha20Poly1305";

export interface CountedE2eeNativePrimitives {
  /** The installed provider's self-test result per primitive. */
  readonly support: () => Readonly<Record<E2eeNativePrimitiveName, boolean>>;
  /** The primitives a caller has reached since installation, sorted. */
  readonly used: () => ReadonlyArray<E2eeNativePrimitiveName>;
  /** Remove the provider again. */
  readonly uninstall: () => void;
}

/** Install the `node:crypto` provider, counting which primitives are reached. */
export function installCountedE2eeNodeNativePrimitives(): CountedE2eeNativePrimitives {
  const provider = makeE2eeNodeNativePrimitives();
  const used = new Set<E2eeNativePrimitiveName>();
  function counted<A extends ReadonlyArray<unknown>, R>(
    name: E2eeNativePrimitiveName,
    primitive: ((...args: A) => R) | undefined,
  ): ((...args: A) => R) | undefined {
    if (primitive === undefined) return undefined;
    return (...args) => {
      used.add(name);
      return primitive(...args);
    };
  }
  const native: E2eeNativePrimitives = {
    get x25519PublicKey() {
      return counted("x25519", provider.x25519PublicKey);
    },
    get x25519SharedSecret() {
      return counted("x25519", provider.x25519SharedSecret);
    },
    get ed25519Verify() {
      return counted("ed25519", provider.ed25519Verify);
    },
    get p256Verify() {
      return counted("p256", provider.p256Verify);
    },
    get chacha20Poly1305() {
      const aead = provider.chacha20Poly1305;
      if (aead === undefined) return undefined;
      return {
        minBytes: aead.minBytes,
        seal: counted("chacha20Poly1305", aead.seal.bind(aead))!,
        open: counted("chacha20Poly1305", aead.open.bind(aead))!,
      };
    },
  };
  installE2eeNativePrimitives(native);
  return {
    support: () => provider.support(),
    used: () => [...used].toSorted(),
    uninstall: () => installE2eeNativePrimitives(undefined),
  };
}
