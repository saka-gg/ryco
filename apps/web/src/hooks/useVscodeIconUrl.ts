import { useEffect, useState } from "react";

type VscodeIconResolver = typeof import("~/vscode-icons").getVscodeIconUrlForEntry;
type VscodeEntryKind = "file" | "directory";
type VscodeIconTheme = "light" | "dark";

let loadedResolver: VscodeIconResolver | null = null;
let resolverPromise: Promise<VscodeIconResolver> | null = null;

function loadVscodeIconResolver(): Promise<VscodeIconResolver> {
  if (loadedResolver) {
    return Promise.resolve(loadedResolver);
  }
  resolverPromise ??= import("~/vscode-icons")
    .then((module) => {
      loadedResolver = module.getVscodeIconUrlForEntry;
      return loadedResolver;
    })
    .catch((error: unknown) => {
      resolverPromise = null;
      throw error;
    });
  return resolverPromise;
}

/** Loads the icon lookup ahead of a tree render, so rows paint with icons. */
export function preloadVscodeIconResolver(): void {
  void loadVscodeIconResolver().catch(() => undefined);
}

export function useVscodeIconUrl(
  pathValue: string,
  kind: VscodeEntryKind,
  theme: VscodeIconTheme,
): string | null {
  const [iconUrl, setIconUrl] = useState<string | null>(() =>
    loadedResolver ? loadedResolver(pathValue, kind, theme) : null,
  );

  useEffect(() => {
    if (loadedResolver) {
      setIconUrl(loadedResolver(pathValue, kind, theme));
      return;
    }

    let cancelled = false;
    setIconUrl(null);

    void loadVscodeIconResolver()
      .then((resolver) => {
        if (!cancelled) {
          setIconUrl(resolver(pathValue, kind, theme));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setIconUrl(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [kind, pathValue, theme]);

  return iconUrl;
}
