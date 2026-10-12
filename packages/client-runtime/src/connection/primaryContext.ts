import {
  attachEnvironmentDescriptor,
  createKnownEnvironment,
  type KnownEnvironment,
} from "../knownEnvironment.ts";
import type { EnvironmentId, ExecutionEnvironmentDescriptor } from "@ryco/contracts";
import type { EndpointService, HttpClientService } from "../platform/index.ts";
import { fetchWithDeadline } from "./fetchWithDeadline.ts";
import type { BootstrapHttpError } from "./primaryAuth.ts";

const SERVER_ENVIRONMENT_DESCRIPTOR_PATH = "/.well-known/ryco/environment";

interface PrimaryEnvironmentBootstrapState {
  readonly descriptor: ExecutionEnvironmentDescriptor | null;
  readonly setDescriptor: (descriptor: ExecutionEnvironmentDescriptor | null) => void;
  readonly reset: () => void;
}

export interface PrimaryEnvironmentContextDependencies {
  readonly endpoint: EndpointService;
  readonly httpClient: HttpClientService;
  readonly retryTransientBootstrap: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly createBootstrapHttpError: (input: {
    readonly message: string;
    readonly status: number;
  }) => BootstrapHttpError;
}

export interface PrimaryEnvironmentStore {
  readonly getState: () => PrimaryEnvironmentBootstrapState;
  readonly subscribe: (listener: () => void) => () => void;
}

function createPrimaryEnvironmentStore(): PrimaryEnvironmentStore {
  let state: PrimaryEnvironmentBootstrapState;
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach((listener) => listener());
  state = {
    descriptor: null,
    setDescriptor: (descriptor) => {
      state = { ...state, descriptor };
      publish();
    },
    reset: () => {
      state = { ...state, descriptor: null };
      publish();
    },
  };
  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function createPrimaryEnvironmentContext(deps: PrimaryEnvironmentContextDependencies) {
  const store = createPrimaryEnvironmentStore();
  let descriptorPromise: Promise<ExecutionEnvironmentDescriptor> | null = null;
  const readDescriptor = () => store.getState().descriptor;
  const writeDescriptor = (descriptor: ExecutionEnvironmentDescriptor | null) =>
    store.getState().setDescriptor(descriptor);
  const getPrimaryKnownEnvironment = (): KnownEnvironment | null => {
    const target = deps.endpoint.readPrimaryTarget();
    const descriptor = readDescriptor();
    if (!target || !descriptor) return null;
    return attachEnvironmentDescriptor(
      createKnownEnvironment({
        id: descriptor.environmentId,
        label: descriptor.label,
        source: target.source,
        target: target.target,
      }),
      descriptor,
    );
  };
  const fetchDescriptor = async (): Promise<ExecutionEnvironmentDescriptor> =>
    deps.retryTransientBootstrap(async () => {
      const response = await fetchWithDeadline(
        deps.httpClient,
        deps.endpoint.resolveHttpUrl(SERVER_ENVIRONMENT_DESCRIPTOR_PATH),
      );
      if (!response.ok) {
        throw deps.createBootstrapHttpError({
          message: `Failed to load server environment descriptor (${response.status}).`,
          status: response.status,
        });
      }
      const descriptor = (await response.json()) as ExecutionEnvironmentDescriptor;
      writeDescriptor(descriptor);
      return descriptor;
    });
  return {
    store,
    readPrimaryEnvironmentDescriptor: readDescriptor,
    writePrimaryEnvironmentDescriptor: writeDescriptor,
    getPrimaryKnownEnvironment,
    resolveInitialPrimaryEnvironmentDescriptor: (): Promise<ExecutionEnvironmentDescriptor> => {
      const descriptor = readDescriptor();
      if (descriptor) return Promise.resolve(descriptor);
      if (descriptorPromise) return descriptorPromise;
      const nextPromise = fetchDescriptor();
      descriptorPromise = nextPromise;
      return nextPromise.finally(() => {
        if (descriptorPromise === nextPromise) descriptorPromise = null;
      });
    },
    resetForTests: () => {
      descriptorPromise = null;
      store.getState().reset();
    },
  };
}

export type PrimaryEnvironmentContext = ReturnType<typeof createPrimaryEnvironmentContext>;
export type { EnvironmentId };
