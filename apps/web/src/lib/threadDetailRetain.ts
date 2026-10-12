/**
 * Upper bound on how long a navigation-time retain keeps a thread's detail
 * subscription alive. It normally ends much earlier: once the thread view has
 * taken its own retain, or when the route settles on another thread or leaves.
 * Afterwards the subscription falls back to the supervisor's idle eviction.
 */
export const THREAD_DETAIL_NAVIGATION_RETAIN_MS = 10_000;
