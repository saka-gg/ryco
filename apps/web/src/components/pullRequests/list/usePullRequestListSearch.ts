import type { ChangeRequest } from "@ryco/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { openExternalLink } from "../../../lib/openExternalLink";
import { useSourceControlChangeRequestSearch } from "../../../rpc/useSourceControl";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { usePullRequestsPage } from "../PullRequestsPageContext";
import {
  PULL_REQUEST_SEARCH_DEBOUNCE_MS,
  PULL_REQUEST_SERVER_SEARCH_MIN_LENGTH,
  parsePullRequestLinkTarget,
  resolvePullRequestLink,
  type PullRequestLinkTarget,
} from "./pullRequestListSearch.logic";

const SERVER_SEARCH_LIMIT = 20;

export interface PullRequestListSearch {
  /** What the field shows (ahead of the debounced URL `q`). */
  readonly text: string;
  readonly setText: (text: string) => void;
  /** Clear the field and the URL query right away. */
  readonly clear: () => void;
  /** Commit pending text now instead of after the debounce (Enter). */
  readonly flush: () => void;
  /** Open a link or `#123` when the text is one; false for plain search text. */
  readonly openReference: (text: string) => boolean;
  /** The committed query (URL `q`), trimmed. */
  readonly query: string;
  /** Host search, used when nothing loaded matches the query. */
  readonly server: {
    readonly active: boolean;
    readonly results: ReadonlyArray<ChangeRequest>;
    readonly isLoading: boolean;
    readonly error: string | null;
  };
}

function hostLabel(url: string): string {
  return /^https?:\/\/(?:www\.)?github\.com\//iu.test(url) ? "Open on GitHub" : "Open link";
}

/**
 * The list's search: the field filters the loaded list locally (the URL `q`,
 * debounced), falls back to the host's search when nothing loaded matches, and
 * treats a pasted link or `#123` + Enter as "open this pull request".
 */
export function usePullRequestListSearch(): PullRequestListSearch {
  const { nav, model, repository, repositories } = usePullRequestsPage();
  const committed = nav.search.q ?? "";
  const [text, setTextState] = useState(committed);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // What this field last committed, to tell its own commits from history moves.
  const lastCommittedRef = useRef(committed);
  const navRef = useRef(nav);
  navRef.current = nav;

  useEffect(() => {
    if (committed === lastCommittedRef.current) return;
    // Back/forward or another surface changed `q`: show it.
    lastCommittedRef.current = committed;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    setTextState(committed);
  }, [committed]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  const commit = useCallback((value: string) => {
    const q = value.trim();
    lastCommittedRef.current = q;
    navRef.current.setSearch({ q: q.length > 0 ? q : undefined });
  }, []);

  const setText = useCallback(
    (value: string) => {
      setTextState(value);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        commit(value);
      }, PULL_REQUEST_SEARCH_DEBOUNCE_MS);
    },
    [commit],
  );

  const textRef = useRef(text);
  textRef.current = text;
  const flush = useCallback(() => {
    if (timerRef.current === null) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
    commit(textRef.current);
  }, [commit]);

  const clear = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    setTextState("");
    if (lastCommittedRef.current !== "" || navRef.current.search.q) commit("");
  }, [commit]);

  // Selecting and clearing `q` are two navigations; the second waits for the
  // first to land so it merges into the new URL state instead of reverting it.
  const clearAfterSelectRef = useRef<number | null>(null);
  useEffect(() => {
    const pending = clearAfterSelectRef.current;
    if (pending === null || nav.search.pr !== pending) return;
    clearAfterSelectRef.current = null;
    if (nav.search.q) commit("");
  }, [commit, nav.search.pr, nav.search.q]);

  // A link into another known repository switches first, then selects.
  const pendingSwitchRef = useRef<{ readonly key: string; readonly number: number } | null>(null);
  const repositoryKey = repository?.key ?? null;
  useEffect(() => {
    const pending = pendingSwitchRef.current;
    if (pending === null) return;
    pendingSwitchRef.current = null;
    if (pending.key === repositoryKey) {
      navRef.current.selectPullRequest(pending.number, { via: "link" });
    }
  }, [repositoryKey]);

  const knownUrlsRef = useRef<ReadonlyMap<number, ChangeRequest>>(model.list.byNumber);
  knownUrlsRef.current = model.list.byNumber;
  const repositoryRef = useRef({ repository, repositories });
  repositoryRef.current = { repository, repositories };

  const open = useCallback(
    (target: PullRequestLinkTarget) => {
      const resolution = resolvePullRequestLink({
        target,
        current: repositoryRef.current.repository,
        repositories: repositoryRef.current.repositories,
        knownUrls: [...knownUrlsRef.current.values()].map((entry) => entry.url),
      });
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
      setTextState("");
      switch (resolution.kind) {
        case "current":
          clearAfterSelectRef.current = resolution.number;
          navRef.current.selectPullRequest(resolution.number, { push: true, via: "link" });
          if (navRef.current.search.pr === resolution.number) clear();
          return;
        case "switch":
          pendingSwitchRef.current = { key: resolution.repository.key, number: resolution.number };
          lastCommittedRef.current = "";
          navRef.current.selectRepository(resolution.repository);
          return;
        case "external":
          clear();
          toastManager.add(
            stackedThreadToast({
              type: "info",
              title: `#${resolution.number} is in another repository`,
              description: "None of your projects has a checkout of it.",
              actionProps: {
                children: hostLabel(resolution.url),
                onClick: () => openExternalLink(resolution.url, "Unable to open pull request"),
              },
            }),
          );
      }
    },
    [clear],
  );

  const openReference = useCallback(
    (value: string) => {
      const target = parsePullRequestLinkTarget(value);
      if (target === null) return false;
      open(target);
      return true;
    },
    [open],
  );

  const query = committed.trim();
  const localEmpty = model.list.groups.length === 0;
  const serverActive =
    query.length >= PULL_REQUEST_SERVER_SEARCH_MIN_LENGTH &&
    localEmpty &&
    !model.list.isLoading &&
    model.environmentId !== null &&
    model.cwd !== null;
  const serverSearch = useSourceControlChangeRequestSearch({
    environmentId: model.environmentId,
    cwd: model.cwd,
    query,
    limit: SERVER_SEARCH_LIMIT,
    enabled: serverActive,
  });
  const server = useMemo(
    () => ({
      active: serverActive,
      results: serverActive ? (serverSearch.data ?? []) : [],
      isLoading: serverActive && serverSearch.data === null && serverSearch.error === null,
      error: serverActive ? (serverSearch.error?.message ?? null) : null,
    }),
    [serverActive, serverSearch.data, serverSearch.error],
  );

  return { text, setText, clear, flush, openReference, query, server };
}
