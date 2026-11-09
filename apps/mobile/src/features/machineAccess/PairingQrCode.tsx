import { useMemo } from "react";
import { View } from "react-native";
import { Path, Rect, Svg } from "react-native-svg";

import { useThemeColor } from "../../lib/useThemeColor";
import { deriveHostedQrMatrix, hostedQrPath, hostedQrViewBoxSize } from "../hostedHub/hostedTotpQr";

/**
 * A pairing link as a QR code, drawn by the same encoder and geometry as the
 * Hub's two-factor code. Dark modules on a light field in either theme: an
 * inverted symbol fails to scan. Renders nothing when the link cannot be
 * encoded; the link itself stays on screen to copy or share.
 */
export function PairingQrCode(props: { readonly value: string; readonly size?: number }) {
  const surface = useThemeColor("--color-qr-surface");
  const module = useThemeColor("--color-qr-module");
  const matrix = useMemo(() => deriveHostedQrMatrix(props.value), [props.value]);
  const path = useMemo(() => (matrix ? hostedQrPath(matrix) : null), [matrix]);
  if (!matrix || !path) return null;
  const side = hostedQrViewBoxSize(matrix);
  const size = props.size ?? 220;
  return (
    <View className="overflow-hidden rounded-2xl border border-border">
      <Svg
        accessibilityRole="image"
        accessibilityLabel="Pairing link QR code"
        width={size}
        height={size}
        viewBox={`0 0 ${side} ${side}`}
      >
        <Rect x={0} y={0} width={side} height={side} fill={surface} />
        <Path d={path} fill={module} />
      </Svg>
    </View>
  );
}
