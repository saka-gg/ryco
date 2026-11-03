import { createStore } from "zustand/vanilla";

/**
 * What the Hub machine rows show about linked direct access, kept apart from
 * the route code (`linkedDirectAccess.ts`) so a row can read it at launch
 * without loading that code. Keyed by the Hub environment id.
 */
export interface MobileLinkedDirectAccessUiState {
  /** Machines with a link, mirrored from the saved catalog by the route code. */
  readonly linked: Readonly<Record<string, true>>;
  /** Machines whose link is being made now. */
  readonly linking: Readonly<Record<string, true>>;
  /** Machines whose latest attempt took a direct route: that route's address. */
  readonly directRoute: Readonly<Record<string, string>>;
  /** What the last "Add direct access" said, when it did not link. */
  readonly notice: Readonly<Record<string, string>>;
}

export const mobileLinkedDirectAccessStore = createStore<MobileLinkedDirectAccessUiState>(() => ({
  linked: {},
  linking: {},
  directRoute: {},
  notice: {},
}));

function patch<K extends keyof MobileLinkedDirectAccessUiState>(
  key: K,
  hubEnvironmentId: string,
  value: MobileLinkedDirectAccessUiState[K][string] | undefined,
): void {
  mobileLinkedDirectAccessStore.setState((state) => {
    const { [hubEnvironmentId]: _previous, ...rest } = state[key];
    return { [key]: value === undefined ? rest : { ...rest, [hubEnvironmentId]: value } };
  });
}

export const setMobileLinking = (hubEnvironmentId: string, linking: boolean) =>
  patch("linking", hubEnvironmentId, linking ? true : undefined);
export const setMobileDirectRoute = (hubEnvironmentId: string, routeKey: string | null) =>
  patch("directRoute", hubEnvironmentId, routeKey ?? undefined);
export const setMobileLinkNotice = (hubEnvironmentId: string, notice: string | null) =>
  patch("notice", hubEnvironmentId, notice ?? undefined);

export const setMobileLinkedHubs = (hubEnvironmentIds: ReadonlyArray<string>) =>
  mobileLinkedDirectAccessStore.setState({
    linked: Object.fromEntries(hubEnvironmentIds.map((id) => [id, true] as const)),
  });
