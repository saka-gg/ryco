// Guards `patches/@vitest%2Fbrowser-playwright@5.0.3.patch`. Replacing a mock while a request for
// its module waits on the factory unroutes the old handler; Playwright then lets the request
// through on its own, and the old handler's late `route.fulfill` used to reject in Vitest's main
// process ("route.fulfill: Route is already handled!"), which ended the whole run as an unhandled
// rejection after every test had passed.
import { expect, it, vi } from "vite-plus/test";

it("keeps the run going when a mock is replaced while its module request waits", async () => {
  let factoryStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    factoryStarted = resolve;
  });
  let releaseFactory!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseFactory = resolve;
  });
  vi.doMock("../../../test/fixtures/moduleMockTarget", async () => {
    factoryStarted();
    await released;
    return { source: "first mock" };
  });
  const loading = import("../../../test/fixtures/moduleMockTarget").then(
    () => "loaded",
    () => "failed",
  );
  await started;
  vi.doMock("../../../test/fixtures/moduleMockTarget", () => ({ source: "second mock" }));
  await import("../../../test/fixtures/moduleMockFlush");
  releaseFactory();
  await loading;
  // The old handler fulfills in Vitest's main process once the factory answered; the failure this
  // guards against is reported there, so keep the run open long enough for it to happen.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  expect(await loading).toMatch(/loaded|failed/);
});
