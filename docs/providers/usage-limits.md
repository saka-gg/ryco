# Usage limits and pace

Provider usage limits describe an account's allowance, including usage from other apps and devices.
They are separate from Ryco's transcript token totals and estimated costs.

Where a provider reports usage, a window duration and a reset, Ryco compares the reported usage
with evenly using that allowance across the window. For example, 40% used at a check made 60% of
the way through the window is **20 percentage points below even pace** (a reserve). 80% used at
that check is **20 percentage points above even pace** (a deficit).

The comparison is labelled **at last check**. Time passing does not improve the comparison without
a new provider snapshot. It is neither a forecast nor banked credit or debt. Refresh provider status
for another check. Each provider instance and window is displayed separately; duplicate instances
and different accounts are never added or averaged into a combined allowance.

Pace is unavailable for disconnected, disabled, unavailable, unready or unauthenticated providers,
missing or invalid inputs, clock inconsistencies, and windows that have reset. Missing usage is
unavailable, never zero. Small differences within two percentage points and the first 3% of a
window have no pace label. Existing usage amounts, credits, reset times and accounting are unchanged.

Claude instances with a separate home use that home's credential file for usage reads. They do not
fall back to the default account's global macOS Keychain entry. Refreshes are persisted only to the
credential store that supplied the account. Missing separate-home credentials mean usage is unavailable.
