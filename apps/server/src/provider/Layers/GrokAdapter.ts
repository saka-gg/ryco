import type { GrokSettings } from "@ryco/contracts";
import { ProviderDriverKind } from "@ryco/contracts";
import { makeAcpAdapter, type AcpAdapterLiveOptions } from "./AcpAdapter.ts";
import { makeGrokAcpRuntime, resolveGrokAcpBaseModelId } from "../acp/GrokAcpSupport.ts";

export type GrokAdapterLiveOptions = Pick<
  AcpAdapterLiveOptions,
  "environment" | "nativeEventLogPath" | "nativeEventLogger" | "instanceId"
>;

export function makeGrokAdapter(grokSettings: GrokSettings, options?: GrokAdapterLiveOptions) {
  return makeAcpAdapter({
    ...options,
    provider: ProviderDriverKind.make("grok"),
    normalizeModel: resolveGrokAcpBaseModelId,
    xaiExtensions: true,
    makeRuntime: (input) =>
      makeGrokAcpRuntime({
        ...input,
        grokSettings,
        ...(options?.environment ? { environment: options.environment } : {}),
      }),
  });
}
