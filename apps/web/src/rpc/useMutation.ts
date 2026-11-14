/**
 * The web app's mutation hook: one request at a time per hook, with `onMutate`, `onSuccess`,
 * `onError` and `onSettled` callbacks and a state that re-renders the caller. It depends on no
 * query cache, so atom-backed modules use it without loading `queryClient`.
 *
 * @module useMutation
 */
import { useCallback, useEffect, useReducer, useRef } from "react";

/** A thrown value as an `Error`. */
export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export interface UseMutationOptions<TData, TVariables, TContext> {
  readonly mutationFn: (variables: TVariables) => Promise<TData>;
  readonly onMutate?: (variables: TVariables) => Promise<TContext> | TContext;
  readonly onError?: (
    error: Error,
    variables: TVariables,
    context: TContext | undefined,
  ) => unknown;
  readonly onSuccess?: (
    data: TData,
    variables: TVariables,
    context: TContext | undefined,
  ) => unknown;
  readonly onSettled?: (
    data: TData | undefined,
    error: Error | null,
    variables: TVariables,
    context: TContext | undefined,
  ) => unknown;
}

type MutationStatus = "idle" | "pending" | "error" | "success";

export interface MutateCallbacks<TData, TVariables> {
  readonly onSuccess?: (data: TData, variables: TVariables) => unknown;
  readonly onError?: (error: Error, variables: TVariables) => unknown;
  readonly onSettled?: (
    data: TData | undefined,
    error: Error | null,
    variables: TVariables,
  ) => unknown;
}

export interface UseMutationResult<TData, TVariables> {
  readonly mutate: (variables: TVariables, callbacks?: MutateCallbacks<TData, TVariables>) => void;
  readonly mutateAsync: (variables: TVariables) => Promise<TData>;
  readonly isPending: boolean;
  readonly isIdle: boolean;
  readonly isError: boolean;
  readonly isSuccess: boolean;
  readonly status: MutationStatus;
  readonly error: Error | null;
  readonly data: TData | undefined;
  readonly variables: TVariables | undefined;
  readonly reset: () => void;
}

interface MutationState<TData, TVariables> {
  readonly status: MutationStatus;
  readonly data: TData | undefined;
  readonly error: Error | null;
  readonly variables: TVariables | undefined;
}

const INITIAL_MUTATION_STATE: MutationState<unknown, unknown> = Object.freeze({
  status: "idle",
  data: undefined,
  error: null,
  variables: undefined,
});

export function useMutation<TData = unknown, TVariables = void, TContext = unknown>(
  options: UseMutationOptions<TData, TVariables, TContext>,
): UseMutationResult<TData, TVariables> {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const stateRef = useRef<MutationState<TData, TVariables>>(
    INITIAL_MUTATION_STATE as MutationState<TData, TVariables>,
  );
  const [, forceRender] = useReducer((tick: number) => tick + 1, 0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const setState = useCallback((next: MutationState<TData, TVariables>) => {
    stateRef.current = next;
    if (mountedRef.current) {
      forceRender();
    }
  }, []);

  const runMutation = useCallback(
    async (
      variables: TVariables,
      callbacks?: MutateCallbacks<TData, TVariables>,
    ): Promise<TData> => {
      const current = optionsRef.current;
      setState({ status: "pending", data: undefined, error: null, variables });
      let context: TContext | undefined;
      try {
        context = current.onMutate ? await current.onMutate(variables) : undefined;
        const data = await current.mutationFn(variables);
        await current.onSuccess?.(data, variables, context);
        await callbacks?.onSuccess?.(data, variables);
        await current.onSettled?.(data, null, variables, context);
        await callbacks?.onSettled?.(data, null, variables);
        setState({ status: "success", data, error: null, variables });
        return data;
      } catch (rawError) {
        const error = toError(rawError);
        await current.onError?.(error, variables, context);
        await callbacks?.onError?.(error, variables);
        await current.onSettled?.(undefined, error, variables, context);
        await callbacks?.onSettled?.(undefined, error, variables);
        setState({ status: "error", data: undefined, error, variables });
        throw error;
      }
    },
    [setState],
  );

  const mutateAsync = useCallback(
    (variables: TVariables): Promise<TData> => runMutation(variables),
    [runMutation],
  );

  const mutate = useCallback(
    (variables: TVariables, callbacks?: MutateCallbacks<TData, TVariables>) => {
      void runMutation(variables, callbacks).catch(() => undefined);
    },
    [runMutation],
  );

  const reset = useCallback(() => {
    setState(INITIAL_MUTATION_STATE as MutationState<TData, TVariables>);
  }, [setState]);

  const state = stateRef.current;
  return {
    mutate,
    mutateAsync,
    isPending: state.status === "pending",
    isIdle: state.status === "idle",
    isError: state.status === "error",
    isSuccess: state.status === "success",
    status: state.status,
    error: state.error,
    data: state.data,
    variables: state.variables,
    reset,
  };
}
