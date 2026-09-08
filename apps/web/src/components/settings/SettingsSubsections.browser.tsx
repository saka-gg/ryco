import "../../index.css";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { SettingsSection } from "./settingsLayout";
import { useSettingsSubsections } from "./useSettingsSubsections";

function Harness() {
  const [open, setOpen] = useState(false);
  const [extra, setExtra] = useState(false);
  const [target, setTarget] = useState<string | null>(null);
  const { contentRef, sections, active } = useSettingsSubsections("general", false, target);
  return (
    <>
      <button onClick={() => setOpen(!open)}>Toggle settings</button>
      <button onClick={() => setExtra(!extra)}>Toggle notifications</button>
      <button onClick={() => setTarget("Quit shortcut")}>Search quit</button>
      <nav>
        {sections.map(({ id, title, element }) => (
          <button
            key={id}
            aria-current={element === active ? "location" : undefined}
            onClick={() => element.scrollIntoView({ block: "start" })}
          >
            {title}
          </button>
        ))}
      </nav>
      {open && (
        <div ref={contentRef} style={{ height: 250, overflow: "auto" }}>
          <SettingsSection title="Behavior">
            <div style={{ height: 320 }}>Behavior controls</div>
          </SettingsSection>
          <SettingsSection title="Confirmations">
            <div style={{ height: 320 }}>
              <h3>Quit shortcut</h3>
            </div>
          </SettingsSection>
          {extra && (
            <SettingsSection title="Notifications">
              <div style={{ height: 320 }}>Notification controls</div>
            </SettingsSection>
          )}
        </div>
      )}
    </>
  );
}

it("discovers late-mounted sections, tracks scroll, reveals search targets, and removes hidden links", async () => {
  const screen = await render(<Harness />);
  await page.getByRole("button", { name: "Toggle settings" }).click();
  const behavior = page.getByRole("button", { name: "Behavior", exact: true });
  await expect.element(behavior).toHaveAttribute("aria-current", "location");
  await page.getByRole("button", { name: "Confirmations", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Confirmations", exact: true }))
    .toHaveAttribute("aria-current", "location");
  await page.getByRole("button", { name: "Toggle notifications" }).click();
  await expect
    .element(page.getByRole("button", { name: "Notifications", exact: true }))
    .toBeInTheDocument();
  await page.getByRole("button", { name: "Toggle notifications" }).click();
  await expect
    .element(page.getByRole("button", { name: "Notifications", exact: true }))
    .not.toBeInTheDocument();
  await behavior.click();
  await page.getByRole("button", { name: "Search quit" }).click();
  await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("Quit shortcut"));
  await screen.unmount();
});
