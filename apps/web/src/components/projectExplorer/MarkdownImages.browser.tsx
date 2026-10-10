import "../../index.css";
import { page, userEvent } from "vite-plus/test/browser";
import { expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { MarkdownView } from "./MarkdownView";

// The sanitizer only keeps http(s) sources, so the tests use the app's own assets.
const asset = (path: string) => `${location.origin}/${path}`;

async function loaded(name: string) {
  await expect
    .poll(() => {
      const image = document.querySelector<HTMLImageElement>(`img[alt="${name}"]`);
      return image?.complete === true && image.naturalWidth > 0;
    })
    .toBe(true);
}

it("expands body images into a preview that pages through the body's images", async () => {
  const text = [
    `![First shot](${asset("apple-touch-icon.png")})`,
    "",
    `Some prose, then a raw image: <img width="1200" height="1200" alt="Second shot" src="${asset("web-app-manifest-192x192.png")}">`,
    "",
    `[![Linked badge](${asset("favicon-96x96.png")})](https://example.com)`,
  ].join("\n");
  const screen = await render(
    <div style={{ width: 300 }}>
      <MarkdownView text={text} />
    </div>,
  );
  try {
    await loaded("First shot");
    await loaded("Second shot");
    // A sized image is narrowed to the column and keeps its proportions.
    const second = document.querySelector<HTMLImageElement>('img[alt="Second shot"]')!;
    const box = second.getBoundingClientRect();
    expect(box.width).toBeLessThanOrEqual(300);
    expect(Math.abs(box.width - box.height)).toBeLessThan(1);
    // A linked image stays a link, not a second control.
    await expect
      .element(page.getByRole("button", { name: "Expand image: Linked badge" }))
      .not.toBeInTheDocument();
    expect(document.querySelector('a[href="https://example.com"] img')).not.toBeNull();

    await page.getByRole("button", { name: "Expand image: Second shot" }).click();
    const dialog = page.getByRole("dialog", { name: "Expanded image preview" });
    await expect.element(dialog).toBeVisible();
    await expect.element(dialog.getByText("Second shot (2/2)")).toBeVisible();
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(dialog.getByText("First shot (1/2)")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(dialog).not.toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});

it("closes only the preview when it was opened inside another dialog", async () => {
  const screen = await render(
    <Dialog open>
      <DialogPopup>
        <DialogTitle>Pull request</DialogTitle>
        <MarkdownView text={`![Screenshot](${asset("apple-touch-icon.png")})`} />
      </DialogPopup>
    </Dialog>,
  );
  try {
    await loaded("Screenshot");
    await page.getByRole("button", { name: "Expand image: Screenshot" }).click();
    const preview = page.getByRole("dialog", { name: "Expanded image preview" });
    await expect.element(preview).toBeVisible();
    await page
      .getByRole("button", { name: "Close image preview" })
      .first()
      .click({ position: { x: 8, y: 8 } });
    await expect.element(preview).not.toBeInTheDocument();
    await expect.element(page.getByRole("dialog", { name: "Pull request" })).toBeVisible();

    await page.getByRole("button", { name: "Expand image: Screenshot" }).click();
    await expect.element(preview).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(preview).not.toBeInTheDocument();
    await expect.element(page.getByRole("dialog", { name: "Pull request" })).toBeVisible();
  } finally {
    await screen.unmount();
  }
});

it("turns an image that cannot load into a link that opens it", async () => {
  const missing = asset("missing-attachment.png");
  const screen = await render(<MarkdownView text={`![Private upload](${missing})`} />);
  try {
    const link = page.getByRole("link", { name: /Private upload/ });
    await expect.element(link).toBeVisible();
    await expect.element(link).toHaveAttribute("href", missing);
    await expect
      .element(page.getByRole("button", { name: /Expand image/ }))
      .not.toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});
