import * as Option from "effect/Option";
import { defineRule } from "vite-plus/lint/plugins";

import { ruleTester } from "./ruleTester.ts";
import { getPropertyName, isIdentifier, unwrapExpression } from "./utils.ts";

/** Reports what the helpers read from each statement and member access, on real oxlint ASTs. */
const probe = defineRule({
  create(context) {
    return {
      ExpressionStatement(node) {
        const expression = unwrapExpression(node.expression);
        const type = Option.match(expression, { onNone: () => "none", onSome: (it) => it.type });
        const target = isIdentifier(expression, "target") ? " target" : "";
        context.report({ node, message: `${type}${target}` });
      },
      MemberExpression(node) {
        const name = Option.getOrElse(getPropertyName(node.property), () => "none");
        context.report({ node, message: `property ${name}` });
      },
    };
  },
});

ruleTester.run("utils", probe, {
  valid: [],
  invalid: [
    {
      name: "unwrapExpression sees through parentheses, `!`, `as` and `<T>`",
      filename: "fixture.ts",
      code: `(target as unknown)!; <never>target; other;`,
      errors: [
        { message: "Identifier target" },
        { message: "Identifier target" },
        { message: "Identifier" },
      ],
    },
    {
      name: "unwrapExpression sees through an optional chain to the member access",
      filename: "fixture.ts",
      code: `target?.name;`,
      errors: [{ message: "MemberExpression" }, { message: "property name" }],
    },
    {
      name: "getPropertyName reads identifiers, private names and string keys only",
      filename: "fixture.ts",
      code: `
        class Box { #secret = 1; read() { this.#secret; } }
        target["label"];
        target[0];
      `,
      errors: [
        { message: "MemberExpression" },
        { message: "property secret" },
        { message: "MemberExpression" },
        { message: "property label" },
        { message: "MemberExpression" },
        { message: "property none" },
      ],
    },
  ],
});
