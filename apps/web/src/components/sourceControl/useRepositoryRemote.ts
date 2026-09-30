import type { RepositoryIdentity, SourceControlProviderInfo } from "@ryco/contracts";
import { useCallback, useMemo, type ElementType } from "react";

import { readLocalApi } from "~/localApi";
import { getSourceControlPresentation } from "~/sourceControlPresentation";

import { deriveRepositoryDisplayName, deriveRepositoryWebUrl } from "../BranchToolbar.logic";
import { GitIcon } from "../Icons";

export interface RepositoryRemote {
  /** Brand mark for a known host, otherwise the git mark for a local-only repository. */
  Icon: ElementType<{ className?: string }>;
  displayName: string | null;
  webUrl: string | null;
  openLabel: string;
  /** Opens the remote in the system browser; a no-op without a browsable remote. */
  open: () => void;
}

/** The repository's remote as the branch pill and the overview rail present it. */
export function useRepositoryRemote(input: {
  identity: RepositoryIdentity | null | undefined;
  provider: SourceControlProviderInfo | null | undefined;
}): RepositoryRemote {
  const { identity, provider } = input;
  const presentation = useMemo(() => getSourceControlPresentation(provider), [provider]);
  const providerKind = provider?.kind ?? null;
  const hasKnownProvider = providerKind !== null && providerKind !== "unknown";
  const webUrl = useMemo(() => deriveRepositoryWebUrl(identity), [identity]);
  const displayName = useMemo(() => deriveRepositoryDisplayName(identity), [identity]);
  const open = useCallback(() => {
    if (!webUrl) return;
    const api = readLocalApi();
    if (!api) return;
    void api.shell.openExternal(webUrl).catch(() => undefined);
  }, [webUrl]);
  return {
    Icon: hasKnownProvider ? presentation.Icon : GitIcon,
    displayName,
    webUrl,
    openLabel: hasKnownProvider ? `Open on ${presentation.providerName}` : "Open repository remote",
    open,
  };
}
