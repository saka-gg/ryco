import type { GrokSettings } from "@ryco/contracts";
import { ProviderDriverKind } from "@ryco/contracts";
import { makeAcpAdapter, type AcpAdapterLiveOptions } from "./AcpAdapter.ts";
import {
  GROK_HIDDEN_SLASH_COMMANDS,
  GROK_REFUSED_SLASH_COMMANDS,
  makeGrokAcpRuntime,
  resolveGrokAcpBaseModelId,
} from "../acp/GrokAcpSupport.ts";

export type GrokAdapterLiveOptions = Pick<
  AcpAdapterLiveOptions,
  "environment" | "nativeEventLogPath" | "nativeEventLogger" | "instanceId" | "processPriority"
>;

export function makeGrokAdapter(grokSettings: GrokSettings, options?: GrokAdapterLiveOptions) {
  return makeAcpAdapter({
    ...options,
    provider: ProviderDriverKind.make("grok"),
    normalizeModel: resolveGrokAcpBaseModelId,
    xaiExtensions: true,
    hiddenCommands: GROK_HIDDEN_SLASH_COMMANDS,
    refusedCommands: GROK_REFUSED_SLASH_COMMANDS,
    makeRuntime: (input) =>
      makeGrokAcpRuntime({
        ...input,
        grokSettings,
        ...(options?.environment ? { environment: options.environment } : {}),
      }),
  });
}
