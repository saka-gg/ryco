/**
 * The in-process RuleTester every `rules/<rule>.test.ts` shares: oxlint's own tester (no spawned
 * binary, no temp files), reporting each case through Vitest. `wiring.test.ts` covers the real
 * CLI path once.
 */
import { RuleTester } from "vite-plus/lint/plugins-dev";
import { describe, it } from "vite-plus/test";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

export const ruleTester = new RuleTester({ languageOptions: { sourceType: "module" } });
