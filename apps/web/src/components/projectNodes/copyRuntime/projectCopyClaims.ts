// FILE: projectCopyClaims.ts
// Purpose: Decides which window of this browser runs a copy. The job records
//          live in shared localStorage (direct and Desktop builds), so every
//          window's start-up resume sees every record. A copy, or an Agent
//          Control approval, is run, resumed, cleaned up or reported only by
//          the window that holds its claim: a Web Lock held for as long as that
//          run lives, released by the browser when the window closes.
// Layer: Web copy runtime, loaded with `copyManager`.

/** One window's hold on a copy (or an approval); release it when the run ends. */
export interface ProjectCopyClaim {
  /** Lets go of the claim; later calls do nothing. */
  readonly release: () => void;
}

export interface ProjectCopyClaims {
  /** Claims `key` for this window; null when a run here or in another window holds it. */
  readonly tryClaim: (key: string) => Promise<ProjectCopyClaim | null>;
}

const LOCK_PREFIX = "ryco:project-copy:";

function onceClaim(release: () => void): ProjectCopyClaim {
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      release();
    },
  };
}

/** Claims this window keeps to itself: the fallback where Web Locks are missing. */
export function createWindowProjectCopyClaims(): ProjectCopyClaims {
  const held = new Set<string>();
  return {
    tryClaim: async (key) => {
      if (held.has(key)) return null;
      held.add(key);
      return onceClaim(() => held.delete(key));
    },
  };
}

type LockRequest = (
  name: string,
  options: { readonly ifAvailable: true },
  callback: (lock: unknown) => Promise<void> | undefined,
) => Promise<unknown>;

/**
 * Claims shared by every window of this origin (`navigator.locks`). Where the
 * API is missing or refuses (an opaque origin), claims fall back to this window:
 * the copy then runs as it did before claims existed.
 */
export function createProjectCopyClaims(
  request: LockRequest | null = defaultLockRequest(),
  fallback: ProjectCopyClaims = createWindowProjectCopyClaims(),
): ProjectCopyClaims {
  if (request === null) return fallback;
  // A released lock is free only once its request settled: a claim this window
  // makes again right after letting go waits for that, instead of finding it held.
  const releasing = new Map<string, Promise<void>>();
  const claimOnce = (key: string) =>
    new Promise<ProjectCopyClaim | null>((resolve) => {
      let answered = false;
      let settled: Promise<void> = Promise.resolve();
      settled = request(`${LOCK_PREFIX}${key}`, { ifAvailable: true }, (lock) => {
        answered = true;
        if (lock === null) {
          resolve(null);
          return undefined;
        }
        // Held until released: the lock request settles only then.
        return new Promise<void>((release) =>
          resolve(
            onceClaim(() => {
              const done = settled.finally(() => {
                if (releasing.get(key) === done) releasing.delete(key);
              });
              releasing.set(key, done);
              release();
            }),
          ),
        );
      }).then(
        () => undefined,
        (error: unknown) => {
          if (answered) return;
          console.warn("Web Locks are unavailable; copies are claimed for this window.", error);
          void fallback.tryClaim(key).then(resolve);
        },
      );
    });
  return {
    tryClaim: async (key) => {
      await releasing.get(key);
      return claimOnce(key);
    },
  };
}

function defaultLockRequest(): LockRequest | null {
  // Typed as always there; older browsers (Safari before 15.4) have no Web Locks.
  const locks = (globalThis.navigator as Partial<Navigator> | undefined)?.locks;
  if (locks === undefined) return null;
  return (name, options, callback) => locks.request(name, options, callback);
}
