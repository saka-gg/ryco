import type { EnvironmentId } from "@ryco/contracts";
import { create } from "zustand";

/** The settings section the model price editor renders, and its search target. */
export const USAGE_PRICE_SECTION_TITLE = "Model prices";

/** A model the Usage page asked the price editor of one node to add a row for. */
export interface UsagePriceRowRequest {
  /** Tells requests for the same model apart (the row's id). */
  readonly serial: number;
  readonly environmentId: EnvironmentId;
  readonly model: string;
}

/**
 * The request waits here until that node's editor mounts and takes it, so the Statistics
 * route never loads the editor itself.
 */
export const useUsagePriceRowRequestStore = create<{
  readonly request: UsagePriceRowRequest | null;
}>(() => ({ request: null }));

let lastSerial = 0;

export function requestUsagePriceRow(environmentId: EnvironmentId, model: string): void {
  lastSerial += 1;
  useUsagePriceRowRequestStore.setState({ request: { serial: lastSerial, environmentId, model } });
}

/** The editor took `request`: drop it, unless a newer request replaced it. */
export function takeUsagePriceRow(request: UsagePriceRowRequest): void {
  if (useUsagePriceRowRequestStore.getState().request !== request) return;
  useUsagePriceRowRequestStore.setState({ request: null });
}
