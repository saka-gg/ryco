import { useColorScheme } from "react-native";

// The approved mockup's numbers ("Machines sheet · per-machine rows", layout C), carried over
// as they are: the list row, the machine page's navigation bar, header and grouped rows, and
// the slide that opens a machine's page inside the sheet.

export const MACHINES_LOOK = {
  dark: {
    /** The sheet itself, opaque, behind a machine's page as it slides in. */
    sheet: "rgb(13,13,13)",
    card: "#141414",
    line: "rgba(255,255,255,0.08)",
    pressed: "rgba(255,255,255,0.04)",
    barPressed: "rgba(255,255,255,0.05)",
    foreground: "#ededed",
    muted: "#949494",
    faint: "#6b6b6b",
    amber: "#ffb43c",
    red: "#ff5f57",
    link: "#8ab4ff",
    check: "#ededed",
  },
  light: {
    sheet: "#f2f2f7",
    card: "#ffffff",
    line: "rgba(0,0,0,0.08)",
    pressed: "rgba(0,0,0,0.04)",
    barPressed: "rgba(0,0,0,0.05)",
    foreground: "#171717",
    muted: "#737373",
    faint: "#a3a3a3",
    amber: "#b26b00",
    red: "#dc2626",
    link: "#1567a0",
    check: "#171717",
  },
} as const;

export type MachinesLook = (typeof MACHINES_LOOK)[keyof typeof MACHINES_LOOK];

export function useMachinesLook(): MachinesLook {
  return useColorScheme() === "light" ? MACHINES_LOOK.light : MACHINES_LOOK.dark;
}

export const MACHINE_PAGE_TITLE_AFTER = 110;
export const MACHINE_PAGE_NAV_HEIGHT = 64;
/** `.dim`: a switched-off machine's avatar and text. */
export const MACHINE_DIMMED_OPACITY = 0.45;
/** `.li.off`: an action this device cannot take now. */
export const MACHINE_ACTION_OFF_OPACITY = 0.4;
