import { ruleTester } from "../ruleTester.ts";
import rule from "./prefer-shared-error-message.ts";

const MESSAGE =
  'Use errorMessage(error, fallback) from "~/lib/errorMessage": it trims, reads a tagged error\'s detail when the message is empty, and keeps thrown strings.';
const WEB_FILE = "/repo/apps/web/src/components/Example.tsx";

ruleTester.run("ryco/prefer-shared-error-message", rule, {
  valid: [
    {
      name: "allows the shared helper",
      filename: WEB_FILE,
      code: `const text = errorMessage(error, "Could not save.");`,
    },
    {
      name: "allows a String(error) fallback, which answers differently",
      filename: WEB_FILE,
      code: `const text = error instanceof Error ? error.message : String(error);`,
    },
    {
      name: "allows a fallback that keeps the raw value",
      filename: WEB_FILE,
      code: `console.warn(error instanceof Error ? error.message : error);`,
    },
    {
      name: "allows a null fallback",
      filename: WEB_FILE,
      code: `const text = error instanceof Error ? error.message : null;`,
    },
    {
      name: "allows reading another value's message",
      filename: WEB_FILE,
      code: `const text = error instanceof Error ? other.message : "x";`,
    },
    {
      name: "allows a named fallback, which may not be a string",
      filename: WEB_FILE,
      code: `const label = error instanceof Error ? error.message : props.emptyLabel;`,
    },
    {
      name: "allows a bare name as the fallback",
      filename: WEB_FILE,
      code: `const text = error instanceof Error ? error.message : fallback;`,
    },
    {
      name: "ignores code outside the web app",
      filename: "/repo/apps/server/src/example.ts",
      code: `const text = error instanceof Error ? error.message : "x";`,
    },
    {
      name: "ignores web tests",
      filename: "/repo/apps/web/src/components/Example.test.ts",
      code: `const text = error instanceof Error ? error.message : "x";`,
    },
    {
      name: "ignores the helper itself",
      filename: "/repo/apps/web/src/lib/errorMessage.ts",
      code: `const text = error instanceof Error ? error.message : "x";`,
    },
  ],
  invalid: [
    {
      name: "reports a string fallback",
      filename: WEB_FILE,
      code: `const text = error instanceof Error ? error.message : "Could not save.";`,
      errors: [{ message: MESSAGE }],
    },
    {
      name: "reports a template fallback",
      filename: WEB_FILE,
      code: "toast(cause instanceof Error ? cause.message : `Failed ${name}.`);",
      errors: [{ message: MESSAGE }],
    },
    {
      name: "reports a member error with a string fallback",
      filename: WEB_FILE,
      code: `const text = query.error instanceof Error ? query.error.message : "Failed.";`,
      errors: [{ message: MESSAGE }],
    },
  ],
});
