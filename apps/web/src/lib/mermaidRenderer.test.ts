import { beforeEach, expect, it, vi } from "vitest";
const { engine } = vi.hoisted(() => ({ engine: vi.fn() }));
vi.mock("./mermaidEngine", () => ({ renderMermaidImage: engine }));
beforeEach(() => {
  vi.resetModules();
  engine.mockReset();
});

it("does not invoke the engine for rejected or inactive input", async () => {
  const { renderMermaid } = await import("./mermaidRenderer");
  expect(await renderMermaid("gantt", "light", () => true)).toBeNull();
  expect(await renderMermaid("flowchart TD\nA-->B", "light", () => false)).toBeNull();
  expect(engine).not.toHaveBeenCalled();
});

it("bounds pending work and does not let a failed job poison later renders", async () => {
  const { renderMermaid } = await import("./mermaidRenderer");
  let release!: () => void;
  engine.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  engine.mockResolvedValue({ src: "data:image/svg+xml,test", width: 100, height: 100 });
  const first = renderMermaid("flowchart TD\nA-->B", "light", () => true);
  await vi.waitFor(() => expect(engine).toHaveBeenCalledTimes(1));
  const jobs = Array.from({ length: 31 }, (_, i) =>
    renderMermaid(`flowchart TD\nN${i}-->B`, "light", () => true),
  );
  expect(await renderMermaid("flowchart TD\nOverflow-->B", "light", () => true)).toBeNull();
  release();
  await expect(first).rejects.toThrow();
  await Promise.all(jobs);
  expect(await renderMermaid("flowchart TD\nOverflow-->B", "light", () => true)).not.toBeNull();
});

it("bounds cache entries and skips a single oversized output", async () => {
  const { renderMermaid, cachedMermaid } = await import("./mermaidRenderer");
  engine.mockResolvedValue({ src: "data:image/svg+xml,test", width: 100, height: 100 });
  for (let i = 0; i < 51; i++) await renderMermaid(`flowchart TD\nN${i}-->B`, "light", () => true);
  expect(cachedMermaid("flowchart TD\nN0-->B", "light")).toBeNull();
  expect(cachedMermaid("flowchart TD\nN50-->B", "light")).not.toBeNull();
  engine.mockResolvedValue({ src: "x".repeat(3 * 1024 * 1024), width: 100, height: 100 });
  await renderMermaid("flowchart TD\nLarge-->B", "light", () => true);
  expect(cachedMermaid("flowchart TD\nLarge-->B", "light")).toBeNull();
});

it("does not publish or cache a result whose last consumer left during rendering", async () => {
  const { renderMermaid, cachedMermaid } = await import("./mermaidRenderer");
  let release!: (value: { src: string; width: number; height: number }) => void;
  engine.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  let active = true;
  const source = "flowchart TD\nLeave-->B";
  const result = renderMermaid(source, "light", () => active);
  await vi.waitFor(() => expect(engine).toHaveBeenCalled());
  active = false;
  release({ src: "svg", width: 1, height: 1 });
  expect(await result).toBeNull();
  expect(cachedMermaid(source, "light")).toBeNull();
});
