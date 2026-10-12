import { SymbolView as ExpoSymbolView, type SymbolViewProps } from "expo-symbols";

// iOS renders SF Symbols natively. The Tabler fallback table in
// `AppSymbol.tsx` exists only for Android, and keeping it out of this file keeps
// its ~80 icon modules out of the iOS bundle entirely.

export type { SFSymbol } from "expo-symbols";
export type AppSymbolName = SymbolViewProps["name"];

export function SymbolView(props: SymbolViewProps) {
  return <ExpoSymbolView {...props} />;
}
