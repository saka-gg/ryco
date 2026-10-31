import { ruleTester } from "../ruleTester.ts";
import rule from "./no-partial-runtime-mock-in-browser-tests.ts";

const MESSAGE =
  "Don't build a partial mock of the environment runtime on importOriginal: one hung a browser run for over ten minutes. Use the real runtime with __setEnvironmentApiOverrideForTests, or mock the whole module.";

ruleTester.run("ryco/no-partial-runtime-mock-in-browser-tests", rule, {
  valid: [
    {
      name: "allows a whole-module mock of the runtime",
      filename: "/repo/apps/web/src/components/Thing.browser.tsx",
      code: `vi.mock("../environments/runtime/service", () => ({ readEnvironmentConnection: vi.fn() }));`,
    },
    {
      name: "allows a partial mock of another module",
      filename: "/repo/apps/web/src/components/Thing.browser.tsx",
      code: `vi.mock("../hostedHub/capabilities", async (importOriginal) => ({ ...(await importOriginal()) }));`,
    },
    {
      name: "ignores unit tests",
      filename: "/repo/apps/web/src/components/Thing.test.tsx",
      code: `vi.mock("~/environmentApi", async (importOriginal) => ({ ...(await importOriginal()) }));`,
    },
  ],
  invalid: [
    {
      name: "reports an importOriginal mock of the runtime service",
      filename: "/repo/apps/web/src/components/Thing.browser.tsx",
      code: `vi.mock("../../environments/runtime/service", async (importOriginal) => {\n  const actual = await importOriginal();\n  return { ...actual };\n});`,
      errors: [{ message: MESSAGE, line: 1 }],
    },
    {
      name: "reports an importOriginal mock of environmentApi",
      filename: "/repo/apps/web/src/chat/Thing.browser.ts",
      code: `vi.mock("~/environmentApi.ts", async function (importOriginal) { return importOriginal(); });`,
      errors: [{ message: MESSAGE }],
    },
    {
      name: "reports a factory spreading vi.importActual of the runtime",
      filename: "/repo/apps/web/src/components/Thing.browser.tsx",
      code: `vi.mock("../environments/runtime/service", async () => ({ ...(await vi.importActual("../environments/runtime/service")), x: 1 }));`,
      errors: [{ message: MESSAGE }],
    },
    {
      name: "reports vi.doMock, an import() specifier, a template path and a sibling path",
      filename: "/repo/apps/web/src/environments/runtime/thing.browser.ts",
      code: `
        vi.doMock("~/environmentApi", async (original) => original());
        vi.mock(import("../../environmentApi"), async (original) => original());
        vi.mock(\`./service\`, async (original) => original());
      `,
      errors: [{ message: MESSAGE }, { message: MESSAGE }, { message: MESSAGE }],
    },
    {
      name: "reports the runtime index module",
      filename: "/repo/apps/web/src/Thing.browser.tsx",
      code: `vi.mock("./environments/runtime", (original) => original());`,
      errors: [{ message: MESSAGE }],
    },
  ],
});
