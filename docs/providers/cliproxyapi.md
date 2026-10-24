# CLIProxyAPI hubs

[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) pools Claude Code, Codex, Antigravity and
API-key credentials behind one proxy. Ryco can read a CLIProxyAPI server ("hub") as a usage source:
it shows how much of each subscription account is left, the hub's view of each account (ready,
cooling down, error, disabled), and request counts for API keys.

Reading a hub is separate from routing agents through it. Ryco never sends turns through a hub on
its own; see [Route a provider through the hub](#route-a-provider-through-the-hub).

## Connect a hub

1. On the hub, set a management secret key (`remote-management.secret-key`, or
   `management.secret-key` in the v8 config layout) and restart CLIProxyAPI. Without a key the hub
   has no management API.
2. If Ryco's node runs on another machine than the hub, enable remote management on the hub
   (`allow-remote: true`). Localhost needs no change. Every request carries the management key, so
   reach remote hubs over `https://` or a private network such as Tailscale.
3. In Ryco, open **Settings → Providers → CLIProxyAPI hubs → Add hub**. Enter the hub URL (for
   example `http://127.0.0.1:8317`), the management key and an optional label. **Test connection**
   checks the URL and key without saving.

The key is stored in the node's secret store. `settings.json` and clients only see that a key is
saved. Leave the key field empty when editing a hub to keep the saved key. A saved key only ever
goes to the address it was entered for (scheme, host and port): changing the hub to another address
asks for the key again. Removing a hub deletes its key; the hub itself is never changed.

### Hubs behind Cloudflare Access

A browser's email-code login does not authenticate Ryco's node. Use a
[Cloudflare Access service token](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
to let the node reach the management API while keeping the browser login:

1. In Cloudflare Zero Trust, open **Access controls → Service credentials → Service Tokens**
   and create a token for Ryco. Copy its **Client ID** and **Client Secret**; the secret is shown
   only when created.
2. Add a policy to the Access application protecting the management hostname: action
   **Service Auth**, include **Service Token**, and select that token. Keep the existing
   browser email-code policy.
3. In Ryco's hub dialog, enter the management hostname's URL, its management secret key, and
   the optional **Cloudflare Access Client ID** and **Cloudflare Access Client Secret**. Use
   **Test connection**, then save. The management key is still required; a client API key
   used by Claude cannot replace it.

Ryco sends the service token on every management call, including quota reads and connection
tests. It does not pass the token to Claude, Codex or other upstream providers. The Client ID
is kept in hub settings; the Client Secret goes into the node's secret store and is redacted
in `settings.json` and settings sent to clients, like the management key.

Leave the secret empty to keep it when editing. Changing the hub address or Client ID requires
entering the secret again. To remove the token, clear both Cloudflare fields and save; removing
the hub also deletes its saved secret. Connection tests use the current form, including an
unsaved token replacement or removal. Older nodes ask you to update Ryco before entering a token.

Ryco does not follow management redirects. A Cloudflare login redirect asks you to check the
token and Service Auth policy; for other redirects, use the destination's direct hub URL.

Hubs are node settings: each Ryco node reads the hubs configured on it. A node running an older
Ryco cannot store hubs; its settings ask you to update it, and the Limits tab says so for that
node. A hub on `localhost` or `127.0.0.1` is a different hub on each node, so the Limits tab lists
it once per node, labelled with the node's name.

## Statistics → Limits

The **Limits** tab on the Statistics page lists every account of every enabled hub, grouped by
provider, next to the accounts provider instances sign in to directly (see
[Usage limits and pace](./usage-limits.md)). When there are both, a source filter shows all of
them, direct accounts only, or hub accounts only. A direct account that a hub also holds (same
provider and email, and not a different plan when both name one) is marked **also in _hub_**; its
hub card is unchanged.

- **Claude**: the 5-hour window, the weekly window and any model-scoped weekly windows
  (for example Opus or Fable), plus the plan.
- **Codex**: the 5-hour and weekly (or monthly) windows, additional limits such as Spark, the plan
  and credits.
- **Antigravity**: each quota bucket Google reports.
- Other providers (Kimi, xAI, …) show their hub status and request counts only.
- **API keys** (`claude-api-key`, `codex-api-key`, OpenAI-compatible entries, …) have no
  subscription quota. Ryco shows the hub's success and failure counts and the last 200 minutes of
  traffic. The hub resets these counters when it restarts. Keys are shown as their last four
  characters only.

With several hub accounts of one provider, a pooled row averages each window across the hub
accounts that reported it. Direct accounts never enter the average; when they share the provider's
panel, the row says **avg of N hub accounts**. Accounts on bigger plans count the same as smaller
ones, so treat the pooled value as a rough guide and read the per-account bars for decisions.

Pace markers work like the provider limits described in [Usage limits and pace](./usage-limits.md).

## In the composer

The context meter next to the send button opens a popup that names the provider instance the
composer sends with: its display name, the login or plan, and the account email (blurred until
clicked).

For a Claude instance routed through a hub (see
[Route a provider through the hub](#route-a-provider-through-the-hub)), the popup reads the node's
hubs when it opens and shows, instead of the instance's own usage limits:

- **Via CLIProxyAPI · _hub_**: the hub whose address matches the instance's `ANTHROPIC_BASE_URL`.
  `localhost`, `127.0.0.1`, `[::1]` and `0.0.0.0` count as the same host, and a trailing `/v1` is
  ignored.
- **Last request**: the Claude account the hub used last, its plan, and when, followed by that
  account's quota windows.
- **Rotating across N accounts** when the hub used several Claude accounts in the last ten
  minutes, as round-robin routing does, plus the pooled average across accounts.
- **All accounts** opens Statistics → Limits for that node.

"Last request" is an approximation. The hub picks an account per request and does not tell its
clients which one it used. Ryco takes the account the hub most recently saw an upstream response
for (the hub records this when Anthropic returns its rate-limit headers). That signal is hub-wide:
another session, or another tool using the same hub, can be the request behind it. Exact
per-session attribution would need Ryco to proxy the requests itself, which it does not do. With
a single Claude account on the hub there is nothing to approximate.

The popup reads hubs only while it is open, never in the background, and reuses a read (its own or
the Limits tab's) for 30 seconds, so hovering it repeatedly does not reach the hub each time.
Reading hubs needs the node's owner role, so operators and viewers on a hosted Hub, and client
sessions paired to a node, do not see these sections. The web phone layout does not show them
either.

## How Ryco reads a hub

- Ryco lists accounts through the hub's management API (`/v8/management/credentials`, falling back
  to `/v0/management/auth-files` on hubs that predate v8).
- Quota comes from the providers' own usage endpoints, called by the hub with each account's own
  token through its `api-call` passthrough. Ryco never sees the account tokens.
- Ryco only reads hubs while the Limits tab or the composer's usage popup is open. Account lists
  are cached for 20 seconds, quota for 5 minutes, and a forced refresh re-reads quota at most once
  a minute per account, because the provider usage endpoints rate-limit aggressively.
- CLIProxyAPI bans a client IP (localhost included) for 30 minutes after five rejected management
  keys, and remembers rejections for up to three hours. Ryco stays below that ban:
  - After the hub rejects a key, Ryco does not send that key again for three hours: not when
    reading, not on **Refresh**, and not from **Test connection**. Save the correct key to read the
    hub again.
  - After four rejected keys at one hub address, Ryco sends that hub no key until the hub has
    forgotten them. Test connection says how long that is.
  - While the hub bans this machine, Ryco does not contact it.
- Ryco does not drain the hub's usage queue. That queue hands each record out once, so reading it
  would take records from other tools such as a usage dashboard.

## Route a provider through the hub

To run agents through a hub, configure the provider instance itself. For Claude, add a Claude
provider with its own Claude home and these environment variables (see
[Claude providers](./claude.md#i-want-to-use-openrouter) for how homes and sensitive variables
work):

```text
ANTHROPIC_BASE_URL   http://127.0.0.1:8317
ANTHROPIC_AUTH_TOKEN <a key from the hub's api-keys list>   Sensitive
ANTHROPIC_API_KEY                                            Empty value
```

The token is a client key from the hub's `api-keys` list, not the management key. A Claude
instance routed this way has no Claude login of its own, so its provider card shows no usage
limits; the Limits tab and the composer's usage popup show the hub's accounts instead.

For Codex, configure a custom model provider pointing at `http://127.0.0.1:8317/v1` with
`wire_api = "responses"` in that instance's Codex home, following the
[CLIProxyAPI Codex guide](https://help.router-for.me/agent-client/codex.html).

## Troubleshooting

| Message                                           | Fix                                                                                                 |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| This hub has no management API.                   | Set a management secret key on the hub and restart it.                                              |
| Cloudflare Access blocked the management request. | Set the hub's service-token fields and allow that token with a Service Auth policy.                 |
| Remote management is disabled on this hub.        | Enable `allow-remote` on the hub, or run Ryco's node on the hub's machine.                          |
| The hub rejected the management key.              | Enter the current key. Ryco does not resend a rejected key for three hours.                         |
| The hub has no Google Cloud project …             | Re-authenticate the Antigravity account on the hub so it records a project.                         |
| Anthropic / ChatGPT refused the request (429)     | The provider rate-limited usage reads. Ryco retries after its cache expires; avoid rapid refreshes. |
