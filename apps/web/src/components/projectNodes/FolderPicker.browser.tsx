import "../../index.css";

import { useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { resetProjectAtomsForTests } from "../../rpc/projectAtoms";
import { defaultQueryClient } from "../../rpc/queryClient";
import { FolderPicker, type FolderPickerProps } from "./FolderPicker";
import type { FolderSelectionStatus } from "@ryco/client-runtime/projectCopy/folderPicker";
import { createFakeNodeApi, FAKE_NODE_ID, FAKE_PROJECTS } from "./projectNodesTestFixtures";

function Harness(
  props: Partial<FolderPickerProps> & {
    readonly initialValue?: string | null;
    readonly onStatus?: (status: FolderSelectionStatus) => void;
  },
) {
  const [value, setValue] = useState<string | null>(props.initialValue ?? null);
  return (
    <div className="w-[560px] p-4">
      <FolderPicker
        environmentId={FAKE_NODE_ID}
        nodeLabel="Mac mini"
        platformOs="darwin"
        supportsProjectCopy
        mode="folder"
        projects={FAKE_PROJECTS}
        autoFocus
        {...props}
        value={value}
        onValueChange={(path) => {
          setValue(path);
          props.onValueChange?.(path);
        }}
        onStatusChange={props.onStatus}
      />
      <output data-testid="selected">{value ?? "none"}</output>
    </div>
  );
}

async function mount(element: ReactElement, options: { projectCopy?: boolean } = {}) {
  const fake = createFakeNodeApi(options);
  __setEnvironmentApiOverrideForTests(FAKE_NODE_ID, fake.api);
  const screen = await render(<AppAtomRegistryProvider>{element}</AppAtomRegistryProvider>);
  return { fake, screen };
}

const status = () => page.getByTestId("folder-picker-status");
const statusLine = () => page.getByTestId("folder-picker-status-line");
const statusPath = () => page.getByTestId("folder-picker-status-path");
const field = () => page.getByRole("combobox", { name: "Search folders on Mac mini" });
const option = (name: RegExp) => page.getByRole("option", { name });

beforeEach(async () => {
  // Places show from the `sm` breakpoint up, as in a desktop dialog.
  await page.viewport(1_280, 800);
});

afterEach(() => {
  __resetEnvironmentApiOverridesForTests();
  resetProjectAtomsForTests();
  defaultQueryClient.clear();
  document.body.innerHTML = "";
});

describe("FolderPicker", () => {
  it("opens on the node's code directory with places, Git repos and marked folders", async () => {
    const { fake, screen } = await mount(<Harness />);
    try {
      const places = page.getByRole("navigation", { name: "Places" });
      await expect.element(places.getByRole("button", { name: "Home" })).toBeVisible();
      await expect.element(places.getByRole("button", { name: "Code" })).toBeVisible();
      await expect.element(places.getByRole("button", { name: "Web" })).toBeVisible();
      // Git repositories under the code roots.
      await expect.element(places.getByRole("button", { name: "ryco-hub" })).toBeVisible();
      await expect.element(places.getByRole("button", { name: "cs2inspect-web" })).toBeVisible();

      const crumbs = page.getByRole("navigation", { name: "Folder path" });
      await expect.element(crumbs.getByRole("button", { name: "~" })).toBeVisible();
      await expect
        .element(crumbs.getByRole("button", { name: "Code" }))
        .toHaveAttribute("aria-current", "location");

      // The existing project and a repository's branch are marked.
      await expect.element(option(/^ryco ryco$/)).toBeVisible();
      await expect.element(option(/^ryco-hub main$/)).toBeVisible();
      await expect.element(option(/^playground$/)).toBeVisible();
      await expect.element(page.getByText("macOS")).toBeVisible();

      expect(fake.browse).toHaveBeenCalledWith({ partialPath: "/Users/me/Code/" });
      expect(fake.searchDirectories).toHaveBeenCalledWith({
        query: "",
        roots: ["/Users/me/Code"],
        maxDepth: 1,
        limit: 100,
      });
      await expect.element(status()).toHaveTextContent("Select a folder.");
    } finally {
      await screen.unmount();
    }
  });

  it("selects folders and reports what the node says about each", async () => {
    const statuses: FolderSelectionStatus[] = [];
    const { fake, screen } = await mount(<Harness onStatus={(next) => statuses.push(next)} />);
    try {
      await option(/^ryco-hub/).click();
      await expect
        .element(page.getByTestId("selected"))
        .toHaveTextContent("/Users/me/Code/ryco-hub");
      await expect.element(statusPath()).toHaveTextContent("~/Code/ryco-hub");
      await expect.element(statusLine()).toHaveTextContent("Git repository on main");
      await expect.element(status()).toHaveAttribute("data-state", "git-repository");
      expect(fake.previewDestination).toHaveBeenCalledWith({ path: "/Users/me/Code/ryco-hub" });

      await option(/^playground/).click();
      await expect.element(statusLine()).toHaveTextContent("Plain folder (no Git)");

      await option(/^ryco ryco$/).click();
      await expect
        .element(statusLine())
        .toHaveTextContent("This is already the project ryco on Mac mini.");
      expect(statuses.at(-1)).toMatchObject({ kind: "existing-project", usable: false });
      // One report per distinct status, not one per render.
      const kinds = statuses.map((entry) => entry.kind);
      expect(kinds.filter((kind) => kind === "existing-project")).toHaveLength(1);
    } finally {
      await screen.unmount();
    }
  });

  it("shows the selection's full path over what it is, and goes up a folder", async () => {
    const { screen } = await mount(<Harness size="large" className="w-[420px]" />);
    try {
      // Nothing selected: the bar asks for a folder and names the keys that pick one.
      await expect.element(statusPath()).not.toBeInTheDocument();
      await expect.element(statusLine()).toHaveTextContent("Select a folder.");
      await expect.element(status()).toMatchTextContent(/move.*open.*select/);

      await option(/^ryco-hub/).click();
      await expect.element(statusPath()).toHaveTextContent("~/Code/ryco-hub");
      await expect.element(statusLine()).toHaveTextContent("Git repository on main");
      const path = statusPath().element().querySelector<HTMLElement>('[data-slot="node-path"]')!;
      // The full path is the tooltip; a path that doesn't fit gives way at its start.
      expect(path.title).toBe("/Users/me/Code/ryco-hub");
      expect(getComputedStyle(path).direction).toBe("rtl");

      // An existing project is marked with its icon and name, in its row and in the bar.
      await option(/^ryco ryco$/).click();
      await expect.element(status()).toHaveAttribute("data-state", "existing-project");
      await expect.element(statusPath()).toHaveTextContent("~/Code/ryco");
      const badge = option(/^ryco ryco$/)
        .element()
        .querySelector('[data-slot="folder-picker-project"]');
      expect(badge?.textContent).toMatch(/ryco$/);
      expect(badge?.querySelector("img, svg")).not.toBeNull();

      // Up leaves ~/Code for home; home has nothing above it in the crumbs.
      const crumbs = page.getByRole("navigation", { name: "Folder path" });
      await crumbs.getByRole("button", { name: "Up one folder" }).click();
      await expect
        .element(crumbs.getByRole("button", { name: "~" }))
        .toHaveAttribute("aria-current", "location");
      await expect.element(option(/^Code$/)).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("moves through folders with the keyboard, breadcrumbs and places", async () => {
    const onSubmit = vi.fn();
    const { screen } = await mount(<Harness onSubmit={onSubmit} />);
    try {
      await expect.element(option(/^playground/)).toBeVisible();
      await expect.element(field()).toHaveFocus();

      // ↓ highlights the first folder, → opens it, Backspace goes back up.
      await userEvent.keyboard("{ArrowDown}");
      await expect.element(option(/^playground/)).toHaveAttribute("data-active", "");
      await userEvent.keyboard("{ArrowRight}");
      await expect.element(option(/^notes/)).toBeVisible();
      await userEvent.keyboard("{Backspace}");
      await expect.element(option(/^ryco-hub/)).toBeVisible();

      // Enter selects the highlighted folder; Enter again submits it.
      await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");
      await expect
        .element(page.getByTestId("selected"))
        .toHaveTextContent("/Users/me/Code/ryco-hub");
      await expect.element(statusLine()).toHaveTextContent("Git repository on main");
      await userEvent.keyboard("{Enter}");
      expect(onSubmit).toHaveBeenCalledWith("/Users/me/Code/ryco-hub");

      // A breadcrumb and a place navigate.
      await page
        .getByRole("navigation", { name: "Folder path" })
        .getByRole("button", { name: "~" })
        .click();
      await expect.element(option(/^Dropbox/)).toBeVisible();
      await expect.element(option(/^\.dotfiles/)).not.toBeInTheDocument();
      await page
        .getByRole("navigation", { name: "Places" })
        .getByRole("button", { name: "Web" })
        .click();
      await expect.element(option(/^homebrew-tap main$/)).toBeVisible();

      // A Git repo place opens its parent and selects it.
      await page
        .getByRole("navigation", { name: "Places" })
        .getByRole("button", { name: "ryco-hub" })
        .click();
      await expect
        .element(page.getByTestId("selected"))
        .toHaveTextContent("/Users/me/Code/ryco-hub");
      await expect.element(option(/^ryco-hub/)).toHaveAttribute("aria-selected", "true");
    } finally {
      await screen.unmount();
    }
  });

  it("searches the node's folders as you type and clears back to the listing", async () => {
    const { fake, screen } = await mount(<Harness />);
    try {
      await expect.element(option(/^playground/)).toBeVisible();
      await field().fill("tap");
      await expect.element(page.getByText("1 folder on Mac mini")).toBeVisible();
      // The folder's name leads, with the match marked; its parent folder follows, muted.
      const result = option(/^homebrew-tap ~\/Dropbox\/Code\/Web/);
      await expect.element(result).toBeVisible();
      await expect.element(result.getByText("tap", { exact: true })).toBeVisible();
      expect(fake.searchDirectories).toHaveBeenCalledWith({ query: "tap", limit: 40 });

      await userEvent.keyboard("{ArrowDown}{Enter}");
      await expect
        .element(page.getByTestId("selected"))
        .toHaveTextContent("/Users/me/Dropbox/Code/Web/homebrew-tap");

      await field().fill("nothing-like-this");
      await expect
        .element(page.getByText("No folder matches “nothing-like-this” on Mac mini."))
        .toBeVisible();

      // Escape clears the field before it would close a dialog.
      await userEvent.keyboard("{Escape}");
      await expect.element(field()).toHaveValue("");
      await expect.element(option(/^playground/)).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("says 'type more' only when more folders matched than it shows", async () => {
    const { fake, screen } = await mount(<Harness />);
    try {
      const note = page.getByTestId("folder-picker-search-note");
      const fakeSearch = fake.searchDirectories.getMockImplementation()!;
      // Every match fits: no note (a capped directory on the node never sets one either).
      fake.searchDirectories.mockImplementationOnce(async (input) => ({
        ...(await fakeSearch(input)),
        limitReached: false,
      }));
      await field().fill("ryco-hub");
      await expect.element(option(/^ryco-hub ~\/Code main$/)).toBeVisible();
      await expect.element(note).not.toBeInTheDocument();

      fake.searchDirectories.mockImplementationOnce(async (input) => ({
        ...(await fakeSearch(input)),
        limitReached: true,
      }));
      await field().fill("Code");
      await expect
        .element(note)
        .toHaveTextContent("Showing the best matches. Type more to narrow them down.");

      fake.searchDirectories.mockImplementationOnce(async (input) => ({
        ...(await fakeSearch(input)),
        truncated: true,
        limitReached: false,
      }));
      await field().fill("Cod");
      await expect
        .element(note)
        .toMatchTextContent(/^Mac mini stopped searching before it looked everywhere\./);
    } finally {
      await screen.unmount();
    }
  });

  it("cuts a long result path at its start so the folder's name stays visible", async () => {
    const { screen } = await mount(<Harness className="w-[220px]" />);
    try {
      await field().fill("cs2inspect");
      const result = option(/cs2inspect-web/);
      await expect.element(result).toBeVisible();
      const path = result.element().querySelector<HTMLElement>('[data-slot="node-path"]')!;
      expect(path.title).toBe("/Users/me/Dropbox/Code/Web/cs2inspect-web");
      // The text overflows its box, and the box's end (the folder's name) is what shows.
      expect(path.scrollWidth).toBeGreaterThan(path.clientWidth);
      expect(getComputedStyle(path).direction).toBe("rtl");
      expect(getComputedStyle(path).textOverflow).toBe("ellipsis");
    } finally {
      await screen.unmount();
    }
  });

  it("offers the node's free folder when a clone destination is taken", async () => {
    const onUseSuggestedPath = vi.fn();
    const { screen } = await mount(
      <Harness
        mode="parent"
        childName="ryco"
        initialValue="/Users/me/Code"
        onUseSuggestedPath={onUseSuggestedPath}
      />,
    );
    try {
      // An existing project sits there; the node names the next free folder.
      await expect.element(status()).toHaveAttribute("data-state", "existing-project");
      await expect
        .element(status().getByText("This is already the project ryco on Mac mini."))
        .toBeVisible();
      await page.getByRole("button", { name: "Use ryco-2" }).click();
      expect(onUseSuggestedPath).toHaveBeenCalledWith("/Users/me/Code/ryco-2");

      await option(/^ryco-hub/).click();
      await expect.element(statusPath()).toHaveTextContent("~/Code/ryco-hub/ryco");
      await expect
        .element(statusLine())
        .toHaveTextContent("New folder; it's created for the project.");
      await expect.element(status()).toHaveAttribute("data-tone", "positive");
    } finally {
      await screen.unmount();
    }

    const occupied = await mount(
      <Harness
        mode="parent"
        childName="Web"
        initialValue="/Users/me/Dropbox/Code"
        onUseSuggestedPath={onUseSuggestedPath}
      />,
    );
    try {
      await expect.element(status()).toHaveAttribute("data-state", "occupied");
      await expect.element(statusPath()).toHaveTextContent("~/Dropbox/Code/Web");
      await expect.element(status().getByText("This folder already exists.")).toBeVisible();
      await page.getByRole("button", { name: "Use Web-2" }).click();
      expect(onUseSuggestedPath).toHaveBeenLastCalledWith("/Users/me/Dropbox/Code/Web-2");
    } finally {
      await occupied.screen.unmount();
    }
  });

  it("badges checkouts of the repository being linked", async () => {
    const { screen } = await mount(
      <Harness
        mode="link"
        initialQuery="ryco"
        expectedRepositoryCanonicalKey="github.com/sak0a/ryco-hub"
      />,
    );
    try {
      const hub = option(/^ryco-hub ~\/Code same repository main$/);
      await expect.element(hub).toBeVisible();
      await expect.element(hub.getByText("same repository")).toBeVisible();
      await expect
        .element(option(/^ryco ~\/Code ryco$/).getByText("same repository"))
        .not.toBeInTheDocument();

      await hub.click();
      await expect.element(statusLine()).toHaveTextContent("Same repository, on main");
      await option(/^ryco ~\/Code ryco$/).click();
      await expect.element(status()).toHaveAttribute("data-state", "existing-project");
    } finally {
      await screen.unmount();
    }
  });

  it("only browses a node without project copy", async () => {
    const { fake, screen } = await mount(
      <Harness supportsProjectCopy={false} initialDirectory="~/Code" />,
      { projectCopy: false },
    );
    try {
      await expect.element(option(/^playground$/)).toBeVisible();
      const places = page.getByRole("navigation", { name: "Places" });
      await expect.element(places.getByRole("button", { name: "Home" })).toBeVisible();
      await expect.element(places.getByText("Git repos")).not.toBeInTheDocument();

      // Text filters the listing by prefix; a path browses there.
      await field().fill("ryco");
      await expect.element(option(/^ryco ryco$/)).toBeVisible();
      await expect.element(option(/^ryco-hub$/)).toBeVisible();
      await expect.element(option(/^playground$/)).not.toBeInTheDocument();
      await field().fill("~/Dropbox/Code/");
      await expect.element(option(/^Web$/)).toBeVisible();
      await userEvent.keyboard("{Enter}");
      await expect.element(field()).toHaveValue("");
      await expect.element(option(/^Web$/)).toBeVisible();

      await option(/^Web$/).click();
      await expect.element(status()).toHaveAttribute("data-state", "unchecked");
      await expect.element(statusPath()).toHaveTextContent("/Users/me/Dropbox/Code/Web");
      await expect
        .element(statusLine())
        .toHaveTextContent("Folder on Mac mini; it's checked when you add it.");
      expect(fake.searchDirectories).not.toHaveBeenCalled();
      expect(fake.pathHints).not.toHaveBeenCalled();
      expect(fake.previewDestination).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("shows loading, failure and empty states", async () => {
    const { fake, screen } = await mount(<Harness initialDirectory="/Users/me/Documents" />);
    try {
      await expect.element(page.getByText("Empty folder")).toBeVisible();

      let release: () => void = () => undefined;
      fake.browse.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            release = () => reject(new Error("Permission denied"));
          }),
      );
      await page
        .getByRole("navigation", { name: "Places" })
        .getByRole("button", { name: "Code" })
        .click();
      await expect.element(page.getByText("Loading folders…")).toBeVisible();
      release();
      await expect
        .element(page.getByText("Couldn't open this folder: Permission denied"))
        .toBeVisible();
      await page.getByRole("button", { name: "Try again" }).click();
      await expect.element(option(/^playground/)).toBeVisible();

      fake.searchDirectories.mockRejectedValueOnce(new Error("Search budget exceeded"));
      await field().fill("web");
      await expect
        .element(page.getByText("Couldn't search Mac mini: Search budget exceeded"))
        .toBeVisible();
      await page.getByRole("button", { name: "Try again" }).click();
      await expect.element(option(/^Web ~\/Dropbox\/Code$/)).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});
