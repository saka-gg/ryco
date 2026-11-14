import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { isPastStaleTime, KEYED_QUERY_STATE_BUILDERS } from "./keyedQueryState";

describe("KEYED_QUERY_STATE_BUILDERS", () => {
  const error = new Error("boom");

  it("keeps data while fetching and loads only without it", () => {
    const { buildFetchingState, initialState } = KEYED_QUERY_STATE_BUILDERS;
    expect(buildFetchingState(initialState)).toEqual({
      data: null,
      isLoading: true,
      isFetching: true,
      isError: false,
      error: null,
    });
    expect(buildFetchingState({ ...initialState, data: [1], isError: true, error })).toEqual({
      data: [1],
      isLoading: false,
      isFetching: true,
      isError: false,
      error: null,
    });
  });

  it("settles to success or to an error that keeps the last data", () => {
    const { buildSuccessState, buildErrorState, isErrorState, initialState } =
      KEYED_QUERY_STATE_BUILDERS;
    const success = buildSuccessState("value");
    expect(success).toEqual({
      data: "value",
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null,
    });
    expect(isErrorState(success)).toBe(false);
    const failed = buildErrorState({ ...initialState, data: "value", isFetching: true }, error);
    expect(failed).toEqual({
      data: "value",
      isLoading: false,
      isFetching: false,
      isError: true,
      error,
    });
    expect(isErrorState(failed)).toBe(true);
  });
});

describe("isPastStaleTime", () => {
  afterEach(() => vi.useRealTimers());

  it("fetches without data, and once the stale time has passed", () => {
    vi.useFakeTimers({ now: 10_000 });
    expect(isPastStaleTime({ hasData: false, lastFetchedAt: 10_000, staleTime: 60_000 })).toBe(
      true,
    );
    expect(isPastStaleTime({ hasData: true, lastFetchedAt: 9_000, staleTime: 2_000 })).toBe(false);
    expect(isPastStaleTime({ hasData: true, lastFetchedAt: 8_000, staleTime: 2_000 })).toBe(true);
    expect(isPastStaleTime({ hasData: true, lastFetchedAt: 10_000, staleTime: 0 })).toBe(true);
  });
});
