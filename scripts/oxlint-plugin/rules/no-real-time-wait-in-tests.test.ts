import { ruleTester } from "../ruleTester.ts";
import rule from "./no-real-time-wait-in-tests.ts";

const REAL_CLOCK =
  "Real-clock wait in a test. Await the `Deferred`/`Queue`/event that marks the milestone, or run under `it.effect` and `TestClock.adjust`. `it.live` is for subprocess/network fixtures, not for sleeping.";
const UNDRIVEN =
  "Sleeps on the TestClock never fire without `TestClock.adjust`; this test can only time out.";
const MIXED = `${REAL_CLOCK} \`setTimeout\` is wall-clock while \`Effect.sleep\` here is TestClock; they never meet.`;

ruleTester.run("ryco/no-real-time-wait-in-tests", rule, {
  valid: [
    {
      name: "allows TestClock-driven sleeps and timeout safety nets",
      filename: "fixture.test.ts",
      code: `
        it.effect("fires after a minute", () =>
          Effect.gen(function* () {
            const fiber = yield* Effect.sleep("1 minute").pipe(Effect.forkChild);
            yield* TestClock.adjust("1 minute");
            yield* fiber.await;
          }),
        );
        it.live("spawns a fixture", () => Effect.void.pipe(Effect.timeout("5 seconds")));
      `,
    },
    {
      name: "allows a macrotask flush: no delay, delay 0, or setImmediate",
      filename: "fixture.test.ts",
      code: `
        import { setImmediate as flushIo, setTimeout as tick } from "node:timers/promises";
        it("flushes", async () => {
          await new Promise((resolve) => setTimeout(resolve));
          await new Promise((resolve) => setTimeout(resolve, 0));
          await new Promise((resolve) => setImmediate(resolve));
          await tick();
          await tick(0);
          await flushIo();
        });
      `,
    },
    {
      name: "allows shared helpers in files that drive the TestClock",
      filename: "fixture.test.ts",
      code: `
        const slowStep = (delay: number) =>
          Effect.gen(function* () {
            if (delay > 0) yield* Effect.sleep(delay);
          });
        it.effect("advances", () => slowStep(5).pipe(Effect.andThen(TestClock.adjust(5))));
      `,
    },
    {
      name: "allows a timer callback outside a promise executor",
      filename: "fixture.test.ts",
      code: `
        it("schedules work", () => {
          const handle = setTimeout(() => {}, 1000);
          clearTimeout(handle);
        });
      `,
    },
    {
      name: "ignores files that are not tests",
      filename: "fixture.ts",
      code: `export const wait = () => new Promise((resolve) => setTimeout(resolve, 50));`,
    },
  ],
  invalid: [
    {
      name: "reports a promise that sleeps on setTimeout",
      filename: "fixture.test.ts",
      code: `it("waits", async () => {\n  await new Promise((resolve) => setTimeout(resolve, 50));\n});`,
      errors: [{ message: REAL_CLOCK, line: 2 }],
    },
    {
      name: "reports timers/promises waits, aliased or through a namespace",
      filename: "fixture.spec.ts",
      code: `
        import { setTimeout as sleep } from "node:timers/promises";
        import * as timers from "timers/promises";
        it("waits", async () => {
          await sleep(10);
          await timers.setTimeout(5);
        });
      `,
      errors: [{ message: REAL_CLOCK }, { message: REAL_CLOCK }],
    },
    {
      name: "reports a TestClock sleep nothing drives",
      filename: "fixture.test.ts",
      code: `it.effect("hangs", () => Effect.sleep("1 second"));`,
      errors: [{ message: UNDRIVEN }],
    },
    {
      name: "reports a polling loop, which only a real clock ends",
      filename: "fixture.test.ts",
      code: `
        const waitFor = (ready: () => boolean) =>
          Effect.gen(function* () {
            while (!ready()) {
              yield* Effect.sleep(10);
            }
          });
        it.effect("polls", () => waitFor(() => true).pipe(Effect.andThen(TestClock.adjust(1))));
      `,
      errors: [{ message: REAL_CLOCK }],
    },
    {
      name: "reports Effect.sleep and Schedule waits under it.live",
      filename: "fixture.test.ts",
      code: `
        it.live("sleeps", () =>
          Effect.sleep(100).pipe(Effect.retry(Schedule.spaced("10 millis"))),
        );
      `,
      errors: [{ message: REAL_CLOCK }, { message: REAL_CLOCK }],
    },
    {
      name: "reports a wall-clock promise under it.effect, which the TestClock never meets",
      filename: "fixture.test.ts",
      code: `
        it.effect("mixes", () =>
          Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10))),
        );
      `,
      errors: [{ message: MIXED }],
    },
    {
      name: "reports setInterval inside a promise executor",
      filename: "fixture.test.ts",
      code: `
        it("polls", async () => {
          await new Promise((resolve) => setInterval(resolve, 0));
        });
      `,
      errors: [{ message: REAL_CLOCK }],
    },
  ],
});
