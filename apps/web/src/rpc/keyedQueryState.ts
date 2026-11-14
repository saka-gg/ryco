/**
 * The query state most atom-backed web reads keep per key (`createKeyedQueryRegistry`), its
 * builders, and the plain stale-time rule for refetching on watch. Domain modules declare only
 * their queries.
 *
 * @module keyedQueryState
 */

export interface KeyedQueryState<T> {
  readonly data: T | null;
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly isError: boolean;
  readonly error: Error | null;
}

const INITIAL_KEYED_QUERY_STATE: KeyedQueryState<never> = Object.freeze({
  data: null,
  isLoading: false,
  isFetching: false,
  isError: false,
  error: null,
});

/** Spread into `createKeyedQueryRegistry<KeyedQueryState<unknown>>({ labelPrefix, ... })`. */
export const KEYED_QUERY_STATE_BUILDERS = {
  initialState: INITIAL_KEYED_QUERY_STATE,
  buildFetchingState: (current: KeyedQueryState<unknown>): KeyedQueryState<unknown> => ({
    data: current.data,
    isLoading: current.data === null,
    isFetching: true,
    isError: false,
    error: null,
  }),
  buildSuccessState: (data: unknown): KeyedQueryState<unknown> => ({
    data,
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
  }),
  buildErrorState: (current: KeyedQueryState<unknown>, error: Error): KeyedQueryState<unknown> => ({
    data: current.data,
    isLoading: false,
    isFetching: false,
    isError: true,
    error,
  }),
  isErrorState: (state: KeyedQueryState<unknown>): boolean => state.isError,
};

/** Fetch on watch when there is no data yet or the last fetch is older than the stale time. */
export function isPastStaleTime(controller: {
  readonly hasData: boolean;
  readonly lastFetchedAt: number;
  readonly staleTime: number;
}): boolean {
  return !controller.hasData || Date.now() - controller.lastFetchedAt >= controller.staleTime;
}

/**
 * Builders for reads moved off the former `queryClient` shim, whose `useQuery` showed data only
 * while the last settled read had succeeded: a failed read drops the data, and the next read
 * stays an error (`isError`, not `isLoading`) until it lands.
 */
export const LAST_RESULT_KEYED_QUERY_STATE_BUILDERS = {
  ...KEYED_QUERY_STATE_BUILDERS,
  buildFetchingState: (current: KeyedQueryState<unknown>): KeyedQueryState<unknown> => ({
    data: current.data,
    isLoading: current.data === null && !current.isError,
    isFetching: true,
    isError: current.isError,
    error: null,
  }),
  buildErrorState: (
    _current: KeyedQueryState<unknown>,
    error: Error,
  ): KeyedQueryState<unknown> => ({
    data: null,
    isLoading: false,
    isFetching: false,
    isError: true,
    error,
  }),
};
