import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";

import {
  CLONE_REMOTE_URL_EMPTY_DETAIL,
  CLONE_REMOTE_URL_SYNTAX_DETAIL,
  resolveCloneCredentials,
  validateCloneRemoteUrl,
  withCloneAskpass,
} from "./gitCloneAccess.ts";
import type * as SourceControlProvider from "./SourceControlProvider.ts";

const AUTHENTICATION = {
  kind: "http-basic" as const,
  username: "x-bitbucket-api-token-auth",
  password: "secret-token",
};

/** A provider that only answers clone credentials, recording each URL it was asked for. */
function credentialProvider(requested: Array<string>) {
  return {
    kind: "bitbucket",
    cloneAuthentication: (input: { readonly remoteUrl: string }) =>
      Effect.sync(() => {
        requested.push(input.remoteUrl);
        return AUTHENTICATION;
      }),
  } as unknown as SourceControlProvider.SourceControlProviderShape;
}

describe("validateCloneRemoteUrl", () => {
  it("accepts https, ssh and scp-style URLs, trimmed", () => {
    for (const url of [
      "https://github.com/octocat/ryco.git",
      "ssh://git@github.com/octocat/ryco.git",
      "git@github.com:octocat/ryco.git",
    ]) {
      assert.deepStrictEqual(validateCloneRemoteUrl(`  ${url} `), Result.succeed(url));
    }
  });

  it("refuses options, local paths and other transports", () => {
    assert.deepStrictEqual(
      validateCloneRemoteUrl("--upload-pack=/tmp/pwn"),
      Result.fail(CLONE_REMOTE_URL_EMPTY_DETAIL),
    );
    assert.deepStrictEqual(validateCloneRemoteUrl(" "), Result.fail(CLONE_REMOTE_URL_EMPTY_DETAIL));
    for (const url of ["file:///tmp/repo.git", "/tmp/repo.git", "http://example.com/r.git"]) {
      assert.deepStrictEqual(
        validateCloneRemoteUrl(url),
        Result.fail(CLONE_REMOTE_URL_SYNTAX_DETAIL),
      );
    }
  });
});

describe("resolveCloneCredentials", () => {
  it.effect("detects the provider of an https URL and strips the URL's user info", () =>
    Effect.gen(function* () {
      const requested: Array<string> = [];
      const provider = credentialProvider(requested);
      const credentials = yield* resolveCloneCredentials({
        registry: {
          get: () => Effect.succeed(provider),
          detectProviderFromRemoteUrl: () => ({
            kind: "bitbucket",
            name: "Bitbucket",
            baseUrl: "https://bitbucket.org",
          }),
        },
        remoteUrl: "https://admin@bitbucket.org/ryco-app/ryco.git",
        provider: null,
      });
      assert.strictEqual(credentials.provider, provider);
      assert.deepStrictEqual(credentials.authentication, AUTHENTICATION);
      assert.strictEqual(credentials.remoteUrl, "https://bitbucket.org/ryco-app/ryco.git");
      assert.deepStrictEqual(requested, ["https://admin@bitbucket.org/ryco-app/ryco.git"]);
    }),
  );

  it.effect("never hands credentials to ssh", () =>
    Effect.gen(function* () {
      const requested: Array<string> = [];
      const credentials = yield* resolveCloneCredentials({
        registry: {
          get: () => Effect.die("no provider lookup for ssh"),
          detectProviderFromRemoteUrl: () => null,
        },
        remoteUrl: "git@bitbucket.org:ryco-app/ryco.git",
        provider: credentialProvider(requested),
      });
      assert.isNull(credentials.authentication);
      assert.strictEqual(credentials.remoteUrl, "git@bitbucket.org:ryco-app/ryco.git");
      assert.deepStrictEqual(requested, []);
    }),
  );
});

describe("withCloneAskpass", () => {
  it.effect("answers git's prompts from a script that lives only as long as the command", () =>
    Effect.gen(function* () {
      let askpassPath = "";
      const answers = yield* withCloneAskpass(AUTHENTICATION, (env) =>
        Effect.sync(() => {
          assert.isDefined(env);
          askpassPath = env?.GIT_ASKPASS ?? "";
          assert.strictEqual(env?.GIT_TERMINAL_PROMPT, "0");
          const ask = (prompt: string) =>
            execFileSync(askpassPath, [prompt], {
              env: { ...process.env, ...env },
              encoding: "utf8",
            }).trim();
          return [
            ask("Username for 'https://bitbucket.org': "),
            ask("Password for 'https://x@bitbucket.org': "),
          ];
        }),
      );
      assert.deepStrictEqual(answers, [AUTHENTICATION.username, AUTHENTICATION.password]);
      assert.isFalse(existsSync(askpassPath));

      const withoutCredentials = yield* withCloneAskpass(null, (env) => Effect.succeed(env));
      assert.isUndefined(withoutCredentials);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
