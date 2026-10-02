import { CheckCircle2Icon, CircleHelpIcon, XCircleIcon } from "lucide-react";

import { Badge } from "../ui/badge";

export type PermissionTone = "success" | "error" | "neutral";

export function permissionStatusPresentation(
  status: string | undefined,
  checked: boolean,
): { readonly label: string; readonly tone: PermissionTone } {
  if (status === "granted") return { label: "Granted", tone: "success" };
  if (status === "restricted") return { label: "Restricted", tone: "error" };
  if (status === "denied") return { label: "Not granted", tone: "error" };
  if (status === "not_required") return { label: "Not required", tone: "neutral" };
  return { label: checked ? "Could not check" : "Not checked", tone: "neutral" };
}

/** One look for an operating-system permission grant, wherever settings shows one. */
export function PermissionStatusBadge({
  status,
  checked = true,
}: {
  status: string | undefined;
  checked?: boolean;
}) {
  const { label, tone } = permissionStatusPresentation(status, checked);
  const Icon =
    tone === "success" ? CheckCircle2Icon : tone === "error" ? XCircleIcon : CircleHelpIcon;
  return (
    <Badge
      size="sm"
      data-permission-status={status ?? "unknown"}
      data-tone={tone}
      variant={tone === "success" ? "success" : tone === "error" ? "error" : "secondary"}
    >
      <Icon aria-hidden />
      {label}
    </Badge>
  );
}
