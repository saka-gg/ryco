import { FORK_ORIGIN_COPY } from "@ryco/client-runtime/state/session";
import type { ContextHandoffEndpointSnapshot } from "@ryco/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import { ContextHandoffEndpointLabel } from "./ContextHandoffEndpointLabel";

export function PendingContextHandoffChip(props: {
  readonly source: ContextHandoffEndpointSnapshot;
  readonly target: ContextHandoffEndpointSnapshot;
  readonly accessibilityLabel: string;
}) {
  const subtle = String(useThemeColor("--color-icon-subtle"));
  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={props.accessibilityLabel}
      className="mx-1 mb-1.5 flex-row items-center gap-1.5 self-start rounded-full border border-border bg-card-translucent px-2.5 py-1.5"
    >
      <SymbolView name="arrow.left.arrow.right" size={13} tintColor={subtle} type="monochrome" />
      <Text className="text-[11px] font-ryco-medium text-foreground-muted">
        Next message hands off context
      </Text>
      <Text className="text-[11px] text-foreground-tertiary">·</Text>
      <ContextHandoffEndpointLabel endpoint={props.source} />
      <SymbolView name="arrow.right" size={12} tintColor={subtle} type="monochrome" />
      <ContextHandoffEndpointLabel endpoint={props.target} emphasized />
    </View>
  );
}

/** A handoff fork's next message delivers its inherited conversation to a fresh session. */
export function PendingForkHandoffChip() {
  const subtle = String(useThemeColor("--color-icon-subtle"));
  const label = FORK_ORIGIN_COPY.handoffPending;
  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={label}
      className="mx-1 mb-1.5 flex-row items-center gap-1.5 self-start rounded-full border border-border bg-card-translucent px-2.5 py-1.5"
    >
      <SymbolView name="arrow.triangle.branch" size={13} tintColor={subtle} type="monochrome" />
      <Text className="shrink text-[11px] font-ryco-medium text-foreground-muted">{label}</Text>
    </View>
  );
}
