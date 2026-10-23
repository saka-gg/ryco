import { describe, expect, it } from "vite-plus/test";
import { redactDiagnosticText } from "./diagnosticRedaction.ts";

describe("diagnostic text redaction", () => {
  it("removes embedded credentials while retaining useful error context", () => {
    const value =
      'Request failed: Bearer very-private-token, password="secret with spaces" url=https://alice:password@example.com/api?ticket=private-ticket#private-fragment';
    const redacted = redactDiagnosticText(value);
    for (const secret of [
      "very-private-token",
      "secret with spaces",
      "alice",
      "private-ticket",
      "private-fragment",
    ]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain("Request failed:");
    expect(redacted).toContain("example.com/api");
  });
  it("removes provider keys, JWTs and multiline private keys", () => {
    expect(redactDiagnosticText("sk-abcdefghijk ghp_abcdefghijkl eyJhbGc.eyJzdWI.signature")).toBe(
      "[redacted] [redacted] [redacted]",
    );
    expect(
      redactDiagnosticText("-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----"),
    ).toBe("[redacted]");
    expect(redactDiagnosticText("Checkpoint took 240 ms")).toBe("Checkpoint took 240 ms");
  });

  it.each([
    // Environment names that end in a credential word.
    ["ANTHROPIC_AUTH_TOKEN=abc123def456", "ANTHROPIC_AUTH_TOKEN=[redacted]"],
    ["OPENAI_API_KEY=abcdef123456", "OPENAI_API_KEY=[redacted]"],
    ["AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG+bPxRfiCY", "AWS_SECRET_ACCESS_KEY=[redacted]"],
    ["CLAUDE_CODE_OAUTH_TOKEN=oat01-abcdefgh", "CLAUDE_CODE_OAUTH_TOKEN=[redacted]"],
    ["GITHUB_TOKEN=ghx_shortvalue", "GITHUB_TOKEN=[redacted]"],
    [
      "MYSQL_PWD=a REDISCLI_AUTH=b STRIPE_KEY=c SMTP_PASS=d",
      "MYSQL_PWD=[redacted] REDISCLI_AUTH=[redacted] STRIPE_KEY=[redacted] SMTP_PASS=[redacted]",
    ],
    // Shell forms keep their quotes and the rest of the command.
    ["export GITHUB_TOKEN='ghx_shortvalue'", "export GITHUB_TOKEN='[redacted]'"],
    ['export OPENAI_API_KEY="sk live value"', 'export OPENAI_API_KEY="[redacted]"'],
    ['docker run -e "GITHUB_TOKEN=abc123" --rm', 'docker run -e "GITHUB_TOKEN=[redacted]" --rm'],
    ['$env:OPENAI_API_KEY="abc"', '$env:OPENAI_API_KEY="[redacted]"'],
    ["--api-key=abc123 --verbose", "--api-key=[redacted] --verbose"],
    [
      "env PASSWORD=\"correct horse\"battery DB_PASSWORD=correct\\ horse\\ battery TOKEN=prefix'middle'suffix bun run dev",
      "env PASSWORD=[redacted] DB_PASSWORD=[redacted] TOKEN=[redacted] bun run dev",
    ],
    // A `$(…)` substitution hides the rest of its line; an unclosed quote the rest of the text.
    ["GITHUB_TOKEN=$(gh auth token) git push\nnext", "GITHUB_TOKEN=[redacted]\nnext"],
    ["API_KEY=`cat key.txt` npm publish", "API_KEY=`[redacted]` npm publish"],
    ["TOKEN=`echo a`suffix next", "TOKEN=[redacted] next"],
    [`TOKEN="$(printf "%s" 'abc def')" next`, "TOKEN=[redacted]"],
    ["SECRET=prefix$(cat secret) next", "SECRET=[redacted]"],
    ['password="abc def\nghi', 'password="[redacted]'],
    ["TOKEN=abc'def ghi' next", "TOKEN=[redacted] next"],
    // An apostrophe in a word is not a quote: prose hides one word, not the lines after it.
    [
      "I rotated the token: it's in the vault now.\nSecond line.",
      "I rotated the token: [redacted] in the vault now.\nSecond line.",
    ],
    ["password: don't commit it\nnext line", "password: [redacted] commit it\nnext line"],
    ["Auth: it's handled.\nline2 'quoted' end", "Auth: [redacted] handled.\nline2 'quoted' end"],
    // A value whose start an earlier rule already hid is hidden whole.
    ["token=ghp_abcdefghijkl-suffix next", "token=[redacted] next"],
    ["Authorization: sk-abcdefghijkl rest\nnext", "Authorization: [redacted]\nnext"],
    // JSON, object literals and configuration files.
    ['{"apiKey":"abc123"}', '{"apiKey":"[redacted]"}'],
    ['{"api_key": "abc123", "model": "gpt-5"}', '{"api_key": "[redacted]", "model": "gpt-5"}'],
    ['{"refreshToken":"a\\"b","id":1}', '{"refreshToken":"[redacted]","id":1}'],
    ['{\\"apiKey\\":\\"abc def\\",\\"x\\":1}', '{\\"apiKey\\":\\"[redacted]\\",\\"x\\":1}'],
    ['{"accessToken": 12345, "ok": true}', '{"accessToken": [redacted], "ok": true}'],
    [
      '"credentials": {"user": "x", "password": "y"}, "region": "eu"',
      '"credentials": [redacted], "region": "eu"',
    ],
    ["{ clientSecret: 'abc', region: 'eu' }", "{ clientSecret: '[redacted]', region: 'eu' }"],
    ["{'api_key': 'abc'}", "{'api_key': '[redacted]'}"],
    ['api_key = "abc"\napi_key: def', 'api_key = "[redacted]"\napi_key: [redacted]'],
    ["//registry.npmjs.org/:_authToken=npm_abc123", "//registry.npmjs.org/:_authToken=[redacted]"],
    [
      "(token=abc) [secret=def] {password=ghi}",
      "(token=[redacted]) [secret=[redacted]] {password=[redacted]}",
    ],
    ["pairingCode: 123456 relay_ticket=abc", "pairingCode: [redacted] relay_ticket=[redacted]"],
    // A camelCase split does not break a credential word apart.
    [
      "passWord: a PassWord=b PassWd=c passPhrase=d",
      "passWord: [redacted] PassWord=[redacted] PassWd=[redacted] passPhrase=[redacted]",
    ],
    // Hash rockets, angle brackets and non-breaking spaces.
    ["secret=>abc", "secret=>[redacted]"],
    ['{"token"=>"abc", "id"=>1}', '{"token"=>"[redacted]", "id"=>1}'],
    ["'password' => 'abc'", "'password' => '[redacted]'"],
    ["token=<abc123> next token=<abc", "token=[redacted] next token=[redacted]"],
    ["token=abc<br>", "token=[redacted]<br>"],
    ["token = abc", "token = [redacted]"],
    // A value alone on the next non-blank line.
    ["password:\n    hunter2\nnext", "password:\n    [redacted]\nnext"],
    ["token=\nabc123", "token=\n[redacted]"],
    ["Your token:\r\n\r\n  abc123\r\n", "Your token:\r\n\r\n  [redacted]\r\n"],
    ["Authorization:\n  Basic dXNlcjpwYXNz\nnext", "Authorization:\n  [redacted]\nnext"],
    ["token:\n  YWJjZA==", "token:\n  [redacted]"],
    // Nested keys and `env` lines on the next line are scanned as assignments of their own.
    ["auth:\n  token: abc\n  user: me", "auth:\n  token: [redacted]\n  user: me"],
    ["auth:\n  token:\n    abc", "auth:\n  token:\n    [redacted]"],
    ["GITHUB_TOKEN=\nOPENAI_API_KEY=abc", "GITHUB_TOKEN=\nOPENAI_API_KEY=[redacted]"],
    // An assignment quoted inside a larger string keeps that string's closing quote.
    [
      '{"message":"request failed: token=abc123","code":401}',
      '{"message":"request failed: token=[redacted]","code":401}',
    ],
    ["url=token=abc", "url=token=[redacted]"],
    // A quote that ends the string without closing it: in shell the value goes on after it.
    ['"token="abc"', '"token="[redacted]"'],
    ['echo "TOKEN="abc123 >> .env', 'echo "TOKEN="[redacted] >> .env'],
    // Markdown code spans, as in agent messages.
    ["Set `GITHUB_TOKEN=abc` before pushing.", "Set `GITHUB_TOKEN=[redacted]` before pushing."],
    ["Use `export GITHUB_TOKEN=abc` here", "Use `export GITHUB_TOKEN=[redacted]` here"],
    ["`apiKey`: `abc123` is set", "`apiKey`: `[redacted]` is set"],
    // Header values hold more than one word.
    ["Authorization: Basic dXNlcjpwYXNz\nnext", "Authorization: [redacted]\nnext"],
    [
      'curl -H "Authorization: Token abc123" https://api.example.com/v1',
      'curl -H "Authorization: [redacted]" https://api.example.com/v1',
    ],
    ["Cookie: session=abc; csrf=xyz", "Cookie: [redacted]"],
    ["x-api-key: abc123", "x-api-key: [redacted]"],
    // URL userinfo in any scheme.
    [
      "DATABASE_URL=postgres://app:hunter2@db.internal:5432/app",
      "DATABASE_URL=postgres://[redacted]@db.internal:5432/app",
    ],
    ["redis://:p@ss@cache:6379/0", "redis://[redacted]@cache:6379/0"],
    [
      "git push https://x-access-token:ghs_abc123@github.com/org/repo.git",
      "git push https://github.com/org/repo.git",
    ],
  ])("redacts %j", (input, expected) => {
    expect(redactDiagnosticText(input)).toBe(expected);
    expect(redactDiagnosticText(expected)).toBe(expected);
  });

  it.each([
    "monkey=banana keyboard=us MONKEY=value TURKEY=istanbul NODE_ENV=development",
    "PWD=/Users/me/project OLDPWD=/tmp",
    '{"usage":{"input_tokens":123,"output_tokens":45,"cache_read_input_tokens":0},"tokens": 4096}',
    "input_tokens: 123, total_tokens=456, max_tokens=8192",
    "tokenCount: 5 tokenizer: cl100k token_type: bearer",
    "author: Jane oauth: enabled passwordless: true secretary: Bob secrets: inherit",
    'Token::new() token == null token := os.Getenv("X")',
    "cache_key: users primary_key=id",
    "Checkpoint took 240 ms at 12:30:45",
    // A line after a key that holds more than one value, a list or a code block is not a value.
    "credentials:\n  user: me\n  region: eu",
    "Rotate the token:\nOpen the settings page.",
    "Required credentials:\n- OPENAI_API_KEY\n- ANTHROPIC_API_KEY",
    "Refresh the token:\n\n```sh\ngh auth refresh\n```\nDone",
    "API_KEY=\nNODE_ENV=production",
    '{"message":"token=","code":1}',
  ])("keeps %j", (input) => {
    expect(redactDiagnosticText(input)).toBe(input);
  });

  it("stays linear on adversarial input", () => {
    const size = 100_000;
    const inputs = [
      "token=".repeat(size / 6),
      '"'.repeat(size),
      `${"a".repeat(size)}:`,
      `${"-".repeat(size)}=`,
      "a.".repeat(size / 2),
      "x://".repeat(size / 4),
      `token="${"a ".repeat(size / 2)}`,
      "TOKEN=$(".repeat(size / 8),
      `token=${"{".repeat(size)}`,
      `token=${"\\".repeat(size)}`,
      "token=abc ".repeat(size / 10),
      '"Cookie: x '.repeat(size / 11),
      'apiKey:\\"'.repeat(size / 9),
      "token=a'".repeat(size / 8),
      "token=`a".repeat(size / 8),
      "token: it's ".repeat(size / 12),
      "token=a'b\n".repeat(size / 10),
      "token=[redacted]-".repeat(size / 17),
      "token:\n".repeat(size / 7),
      'token:\n"a\n'.repeat(size / 10),
      `token:\n${" ".repeat(size)}`,
      "token=>".repeat(size / 7),
      "token=<".repeat(size / 7),
      `postgres://${"a".repeat(size)}`,
    ];
    // This thread's CPU time, not wall time, so a loaded machine cannot fail the budget. The
    // whole set takes tens of milliseconds; rescanning from each match would take minutes.
    const started = process.threadCpuUsage();
    for (const input of inputs) redactDiagnosticText(input);
    const { user, system } = process.threadCpuUsage(started);
    expect((user + system) / 1_000).toBeLessThan(2_000);
  });
});
