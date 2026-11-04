import "../../index.css";

import { describeOfflineSince } from "@ryco/client-runtime/connection";
import type { NodeCatalogEntry } from "@ryco/client-runtime/state/nodes";
import { EnvironmentId } from "@ryco/contracts";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { NodePicker, type NodePickerProps } from "./NodePicker";
import type { NodePickerExtrasMap } from "./nodePicker.logic";
import { fakeNodeEntry, FAKE_PATH_HINTS } from "./projectNodesTestFixtures";

const NOW = Date.parse("2026-10-22T12:00:00Z");
/** The Gaming PC's status line: last seen two hours before NOW, in local time. */
const GAMING_STATUS = `Windows · offline ${describeOfflineSince(NOW - 2 * 3_600_000, { nowMs: NOW })}`;
const LAPTOP = EnvironmentId.make("environment-laptop");
const MINI = EnvironmentId.make("environment-mini");
const BUILD = EnvironmentId.make("environment-build");
const GAMING = EnvironmentId.make("environment-gaming");
const OLD = EnvironmentId.make("environment-old");

const NODES: ReadonlyArray<NodeCatalogEntry> = [
  fakeNodeEntry({
    environmentId: LAPTOP,
    label: "MacBook Pro",
    isPrimary: true,
    isThisDevice: true,
    iconKind: "laptop",
  }),
  fakeNodeEntry({ environmentId: MINI, label: "Mac mini" }),
  fakeNodeEntry({
    environmentId: BUILD,
    label: "hetzner-build",
    platformOs: "linux",
    iconKind: "server",
    canMutate: false,
    mutateBlockedReason: "Update Ryco on hetzner-build to copy projects here",
  }),
  fakeNodeEntry({
    environmentId: GAMING,
    label: "Gaming PC",
    platformOs: "windows",
    presence: "offline",
    lastSeenAt: NOW - 2 * 3_600_000,
  }),
  fakeNodeEntry({
    environmentId: OLD,
    label: "Old server",
    platformOs: "linux",
    projectCopySupport: "no",
  }),
];

const EXTRAS: NodePickerExtrasMap = {
  [LAPTOP]: { projectCount: 3, pathHints: FAKE_PATH_HINTS },
  [MINI]: { projectCount: 1 },
  [GAMING]: { projectCount: 1 },
};

function Harness(props: Partial<NodePickerProps>) {
  const [value, setValue] = useState(props.value ?? null);
  return (
    <div className="w-[560px] p-4">
      <NodePicker
        nodes={NODES}
        extras={EXTRAS}
        nowMs={NOW}
        aria-label="Node"
        {...props}
        value={value}
        onValueChange={(environmentId) => {
          setValue(environmentId);
          props.onValueChange?.(environmentId);
        }}
      />
      <output data-testid="value">{value ?? "all"}</output>
    </div>
  );
}

const radio = (name: RegExp) => page.getByRole("radio", { name });

describe("NodePicker cards", () => {
  it("shows each node's device, presence, projects and code roots", async () => {
    const screen = await render(<Harness />);
    try {
      const laptop = radio(/^MacBook Pro/);
      await expect.element(laptop).toBeVisible();
      await expect.element(laptop.getByText("this device")).toBeVisible();
      await expect.element(laptop.getByText("macOS · online")).toBeVisible();
      await expect
        .element(laptop.getByText("3 projects · ~/Code, ~/Dropbox/Code/Web"))
        .toBeVisible();
      await expect.element(radio(/^Mac mini/).getByText("1 project")).toBeVisible();

      // Unavailable nodes stay visible, disabled with their reason.
      await expect.element(radio(/^Gaming PC/)).toBeDisabled();
      await expect.element(radio(/^Gaming PC/).getByText(GAMING_STATUS)).toBeVisible();
      // Its presence line says why, so it keeps its summary.
      await expect.element(radio(/^Gaming PC/).getByText("1 project")).toBeVisible();
      await expect.element(radio(/^Gaming PC/)).toHaveAccessibleDescription(GAMING_STATUS);
      await expect.element(radio(/^hetzner-build/)).toBeDisabled();
      await expect
        .element(radio(/^hetzner-build/))
        .toHaveAccessibleDescription("Update Ryco on hetzner-build to copy projects here");
      // Unknown or missing project copy support does not block adding a project.
      await expect.element(radio(/^Old server/)).toBeEnabled();
    } finally {
      await screen.unmount();
    }
  });

  it("selects with a click or the arrow keys, skipping disabled nodes", async () => {
    const onValueChange = vi.fn();
    const screen = await render(<Harness onValueChange={onValueChange} />);
    try {
      await radio(/^Mac mini/).click();
      expect(onValueChange).toHaveBeenLastCalledWith(MINI);
      await expect.element(radio(/^Mac mini/)).toHaveAttribute("aria-checked", "true");
      await expect.element(radio(/^Mac mini/)).toHaveFocus();

      // hetzner-build and Gaming PC are disabled, so → lands on Old server.
      await userEvent.keyboard("{ArrowRight}");
      await expect.element(page.getByTestId("value")).toHaveTextContent(OLD);
      await userEvent.keyboard("{ArrowRight}");
      await expect.element(page.getByTestId("value")).toHaveTextContent(LAPTOP);

      // A disabled node never selects.
      await radio(/^Gaming PC/).click({ force: true });
      await expect.element(page.getByTestId("value")).toHaveTextContent(LAPTOP);
    } finally {
      await screen.unmount();
    }
  });

  it("applies the copy requirements and the caller's reasons", async () => {
    const screen = await render(
      <Harness
        requirements={{ requireProjectCopy: true }}
        extras={{ ...EXTRAS, [MINI]: { disabledReason: "has it · ~/dev/ryco" } }}
      />,
    );
    try {
      await expect.element(radio(/^Old server/)).toBeDisabled();
      await expect
        .element(radio(/^Old server/).getByText("Update Ryco on Old server to copy projects here"))
        .toBeVisible();
      await expect.element(radio(/^Mac mini/)).toBeDisabled();
      await expect.element(radio(/^Mac mini/).getByText("has it · ~/dev/ryco")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});

describe("NodePicker chips", () => {
  it("filters by node with an All chip and keeps offline nodes pickable when allowed", async () => {
    const onAll = vi.fn();
    const screen = await render(
      <Harness
        variant="chip"
        requirements={{ allowOffline: true, requireMutate: false }}
        allOption={{ count: 4, onSelect: onAll }}
      />,
    );
    try {
      const group = page.getByRole("radiogroup", { name: "Node" });
      await expect.element(group).toHaveAttribute("data-variant", "chip");
      await expect.element(radio(/^All 4$/)).toHaveAttribute("aria-checked", "true");
      await expect.element(radio(/^MacBook Pro 3$/)).toBeVisible();
      await expect.element(radio(/^Gaming PC/)).toBeEnabled();
      await expect.element(radio(/^Gaming PC/)).toHaveAttribute("title", GAMING_STATUS);

      await radio(/^Gaming PC/).click();
      await expect.element(page.getByTestId("value")).toHaveTextContent(GAMING);
      await expect.element(radio(/^All 4$/)).toHaveAttribute("aria-checked", "false");
      await radio(/^All 4$/).click();
      expect(onAll).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });

  it("disables chips with their reason in the tooltip", async () => {
    const screen = await render(<Harness variant="chip" />);
    try {
      await expect.element(radio(/^Gaming PC/)).toBeDisabled();
      await expect.element(radio(/^Gaming PC/)).toHaveAttribute("title", "Gaming PC is offline");
      await expect.element(radio(/^Gaming PC/)).toHaveAccessibleDescription("Gaming PC is offline");
    } finally {
      await screen.unmount();
    }
  });
});
