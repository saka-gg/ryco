/**
 * The variable that ties a process to the Ryco thread that started it (docs/thread-servers.md).
 *
 * Every agent session and thread terminal is spawned with it set to its thread, and every process
 * it starts inherits it, so a dev server stays attributed after its launching shell exits or the
 * agent settles. The local server scan reads it back from a listener's launch environment (and
 * nothing else from that environment). It is no secret: it names a thread, which grants nothing.
 *
 * Kept tiny and free of other imports: every provider spawn site loads it at boot.
 *
 * @module threadAttributionEnv
 */
export const RYCO_THREAD_ID_ENV = "RYCO_THREAD_ID";

/**
 * `env` (the node's own environment when absent) with the thread's marker, which replaces one it
 * inherited: a Ryco started from another Ryco's thread marks its own threads.
 */
export function withThreadAttribution(
  env: NodeJS.ProcessEnv | undefined,
  threadId: string,
): NodeJS.ProcessEnv {
  return { ...(env ?? process.env), [RYCO_THREAD_ID_ENV]: threadId };
}
