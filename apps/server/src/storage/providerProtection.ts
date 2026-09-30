import { Context, Layer } from "effect";
import type { ServerSettings } from "@ryco/contracts";
import { resolveUsageProtectedPaths } from "../usage/usageProtectedPaths.ts";

/** Shared with provider usage discovery. Resolve declarations only; never open archive/credential content. */
export interface ProviderProtectedPathsShape {
  readonly resolve: (settings: ServerSettings) => readonly string[] | null;
}
export class ProviderProtectedPaths extends Context.Service<
  ProviderProtectedPaths,
  ProviderProtectedPathsShape
>()("ryco/storage/ProviderProtectedPaths") {}

export const ProviderProtectedPathsLive = Layer.succeed(ProviderProtectedPaths, {
  resolve: (settings) => resolveUsageProtectedPaths(settings),
});
