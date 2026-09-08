/**
 * Resolve `catalog:` dependency specs using the workspace catalog.
 *
 * Pure function: returns a new record with every `catalog:…` value replaced by
 * the concrete version string found in `catalog`. Throws on missing entries.
 */
export function resolveCatalogDependencies(
  dependencies: Record<string, string>,
  catalog: Record<string, string>,
  label: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dependencies).map(([name, spec]) => {
      if (typeof spec !== "string" || !spec.startsWith("catalog:")) {
        return [name, spec];
      }

      const catalogKey = spec.slice("catalog:".length).trim();
      const lookupKey = catalogKey.length > 0 ? catalogKey : name;
      const resolved = catalog[lookupKey];

      if (typeof resolved !== "string" || resolved.length === 0) {
        throw new Error(
          `Unable to resolve '${spec}' for ${label} dependency '${name}'. Expected key '${lookupKey}' in root workspace catalog.`,
        );
      }

      return [name, resolved];
    }),
  );
}

export type DependencyOverrides = Record<string, string | Record<string, string>>;

/** Resolve catalog specs without flattening parent-scoped npm overrides. */
export function resolveCatalogOverrides(
  overrides: DependencyOverrides,
  catalog: Record<string, string>,
  label: string,
): DependencyOverrides {
  return Object.fromEntries(
    Object.entries(overrides).map(([parent, spec]) => {
      if (typeof spec === "string") {
        return [parent, resolveCatalogDependencies({ [parent]: spec }, catalog, label)[parent]!];
      }

      // npm's "." entry overrides the parent itself. A version selector is
      // not part of the package's catalog key (including for scoped names).
      const parentName = parent.replace(/@[^/@]+$/, "");
      return [
        parent,
        Object.fromEntries(
          Object.entries(spec).map(([child, value]) => {
            const name = child === "." ? parentName : child;
            return [child, resolveCatalogDependencies({ [name]: value }, catalog, label)[name]!];
          }),
        ),
      ];
    }),
  );
}
