import type { CopyProjectRouteParams } from "./projectSettingsModel";

/** Anything that can navigate by route name; screens pass their `useNavigation()`. */
interface NamedRouteNavigation {
  navigate(name: string, params: object): void;
}

/**
 * Opens the project copy flow from this checkout to the machine picked. The `CopyProject` route
 * belongs to the copy feature; this is the one place the settings name it.
 */
export function openCopyProject(navigation: unknown, params: CopyProjectRouteParams): void {
  (navigation as NamedRouteNavigation).navigate("CopyProject", params);
}
