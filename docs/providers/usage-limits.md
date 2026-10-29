# Usage limits and pace

Provider usage limits describe an account's allowance, including usage from other apps and devices.
They are separate from Ryco's transcript token totals and estimated costs.

Where a provider reports usage, a window duration and a reset, Ryco compares the reported usage
with evenly using that allowance across the window. For example, 40% used at a check made 60% of
the way through the window is **20 percentage points below even pace** (a reserve). 80% used at
that check is **20 percentage points above even pace** (a deficit).

The comparison is labelled **at last check**. Time passing does not improve the comparison without
a new provider snapshot. It is neither a forecast nor banked credit or debt. Refresh provider status
for another check. Each window is displayed separately; duplicate instances of one account and
different accounts are never added or averaged into a combined allowance.

Pace is unavailable for disconnected, disabled, unavailable, unready or unauthenticated providers,
missing or invalid inputs, clock inconsistencies, and windows that have reset. Missing usage is
unavailable, never zero. Small differences within two percentage points and the first 3% of a
window have no pace label. Existing usage amounts, credits, reset times and accounting are unchanged.

Statistics → Limits lists the accounts provider instances sign in to directly, grouped by
provider, next to the accounts pooled in CLIProxyAPI hubs (see
[CLIProxyAPI hubs](./cliproxyapi.md)). An account signed in on several nodes or instances shows
once, with its freshest reading and the nodes it was seen on. Instances count as one account when
they report the same provider, email and plan; a node that reports no plan joins only when that is
unambiguous. Banked Codex resets come from the newest read that reported them. Instances routed
through a hub show a note instead of their own limits, and direct accounts never enter a hub's
pooled average. The iOS app's Limits tab lists accounts the same way, naming the devices each is
signed in on, with a banked-reset block for each device's Codex instance.

Every surface lists each window a provider reports, labelled the same way for direct and hub
accounts. A direct Claude account shows its 5-hour and weekly windows, its model-scoped weekly
windows such as **Weekly · Opus**, and its cloud session credits; older nodes report only the
5-hour and weekly windows. Ryco re-reads usage between full provider checks, so pace is judged
at the time the usage was read, not at the provider's last check.

When Claude or OpenCode Go throttles a usage read (HTTP 429) or the read fails, Ryco keeps
showing the last good numbers with the time they were read and a note that they are not current.
It does not ask that provider again until the cooldown ends: the provider's `Retry-After`, kept
between 1 and 15 minutes (5 without one), or 1 minute after a failure. Numbers older than an hour
and windows that have reset since are not shown. On Statistics → Limits, a full window in
re-served numbers still marks the account **Limit reached**, next to the note. Ryco never uses
re-served numbers to work out when a chat stopped by a usage limit can resume; only a fresh read
does that. A rejected login (401/403) or another account clears them at once. Codex reads its
limits through its app-server, which handles retries itself.

Claude instances with a separate home use that home's credential file for usage reads. They do not
fall back to the default account's global macOS Keychain entry. Refreshes are persisted only to the
credential store that supplied the account. Missing separate-home credentials mean usage is unavailable.

### Codex banked resets

Codex provider settings show the reported banked reset count, available detail rows,
expiry, and account label. The native Statistics → Limits surface provides the same
confirmation and recovery flow. The desktop conversation usage popover also shows
the count and points to provider settings. A missing detail list means only the count
is known; an empty list means details were fetched with no rows. The count is
independent of list length because Codex can cap the returned rows.

Ryco only redeems after **Use one reset → Confirm redemption**. The server uses the
configured provider's normal Codex app-server and credential store. It cross-checks
`account/read.workspaceRouting.chatgptAccountId` against
`account/rateLimits/read.accountId`, reads the actual subprocess account again before
consumption, and revalidates provider configuration. Older runtimes or accounts
without this identity evidence can display reported credits but cannot redeem.
The focused identity decoders were verified against the installed Codex 0.157.0
experimental JSON schema; they do not require regenerating unrelated protocol APIs.
There is no private endpoint fallback, credential-store override, or automatic reset.

One logical attempt has one UUID. Its provider/account binding and key are saved in
the existing platform KV store before dispatch, scoped to environment and provider.
No credentials are stored. An uncertain response, reconnect, remount, or app reload
keeps that key. **Retry same reset attempt** rechecks the original account and reuses
the key, even if its available count is now zero. Switching accounts blocks the
pending attempt until the original account is restored. A storage failure before
dispatch blocks spending. Authoritative outcomes clear the pending attempt; failed
completion storage retains it for reconciliation with the same key.

`reset` and `alreadyRedeemed` are confirmed success. `noCredit` and `nothingToReset`
are confirmed non-consumption outcomes. Limits and credits are fetched again after
an outcome; refresh failure is shown separately and never invents updated balances.
Owner authorization and the shared connection mutation-readiness policy apply.
Tests use fixture clients and do not redeem real credits.

Protocol reference: [official Codex App Server documentation](https://learn.chatgpt.com/docs/app-server).
The [Synara v0.9.2 implementation](https://github.com/Emanuele-web04/synara/tree/v0.9.2)
and [changelog](https://www.trysynara.com/changelog) were reviewed as a reference;
this implementation uses Ryco's existing Effect transport and shared client runtime.
