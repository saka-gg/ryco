/**
 * How many rows of each collection the client keeps per thread. The store trims
 * to these, and the connection supervisor's retained-memory estimate follows
 * the same trims, so both must read them from here.
 */
export const MAX_THREAD_MESSAGES = 2_000;
export const MAX_THREAD_CHECKPOINTS = 500;
export const MAX_THREAD_PROPOSED_PLANS = 200;
export const MAX_THREAD_ACTIVITIES = 500;
