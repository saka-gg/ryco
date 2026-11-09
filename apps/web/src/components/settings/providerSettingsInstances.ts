export type ProviderSettingsListNavigationKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

export function resolveProviderSettingsListNavigationIndex(
  currentIndex: number,
  key: ProviderSettingsListNavigationKey,
  rowCount: number,
): number | null {
  if (rowCount <= 0 || currentIndex < 0 || currentIndex >= rowCount) return null;
  if (key === "Home") return 0;
  if (key === "End") return rowCount - 1;
  if (key === "ArrowDown") return (currentIndex + 1) % rowCount;
  return (currentIndex - 1 + rowCount) % rowCount;
}
