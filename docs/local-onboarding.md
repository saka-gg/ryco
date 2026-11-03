# Local first-run onboarding

Desktop and browsers connected to a loopback Ryco server offer a short setup flow after the
current workspace and client settings have loaded. It shows provider discovery and authentication
status, opens the existing project picker, and introduces tasks, review, and Settings. Its last
tour entry links to **Settings → Connections** for using Ryco on other devices: **Pairing link**,
**Connect a computer** (Remote environments), and on Desktop **Ryco Hub**.

Use **Provider settings** to configure an instance. Provider authentication uses each provider's
own sign-in. **Sign in** on a provider's row opens it below the list, and it starts only when you
click **Sign in** there: for Codex, Ryco runs its device-code login on this computer and shows the
code to enter on the sign-in page; for Claude, Cursor, Grok and OpenCode it runs the provider's own
login in a terminal shown there. Other providers still sign in with their own CLI. A row offers
**Sign in** only while its instance reports no sign-in and needs one: not for a Codex instance on a
custom model provider, and never for a Claude instance whose environment uses other credentials,
such as a CLIProxyAPI hub. The sign-in runs on this computer, not in the dialog, so skipping or
closing setup does not stop it, and Provider settings keeps showing it. Setup does not install a
CLI, change accounts, or enable or disable providers. **Refresh discovery** explicitly rechecks
status; unverified authentication remains labeled as such.

**Add project** opens the normal project picker. **Import from Codex or Claude Code** opens the
project import dialog ([import](providers/import.md)). Closing the picker, the import or Provider
settings returns to the same setup step. Setup writes no project commands of its own. Connection loss disables
setup actions until the current workspace is ready again; it does not change connection recovery.

On Desktop, a folder dropped anywhere on the window during the project step is handed to the same
picker with its path, which opens the project if it already exists and adds it otherwise. A
dropped file is refused with a message. Browsers cannot read a dropped folder's path, so they keep
**Add project** only. Drops are not taken while Settings or the picker is open, or while the
machine reconnects.

The device links only open Settings on this app and scroll to the matching section. **Pairing
link** lands on **Network access**, which decides whether another device can reach this computer;
pairing links are created under **Authorized clients** once one can. Closing Settings returns to
the tour.

Choose **Skip setup**, close the dialog, or finish the quick tour to dismiss it. Replay from
**This app / This browser → General → Welcome tour**. Completion is stored per environment through
the existing client-settings persistence: Desktop's local settings file or the browser's local
storage. It is not a node/server preference, survives normal preference resets, and Desktop's
marker does not depend on its backend port. An existing installation with projects is exempted.
If local persistence fails, the in-memory client settings still dismiss setup for that session;
a later launch may offer it again.

Hub/account enrollment, native trust onboarding, hosted lifecycle recovery, and the frozen web
phone surface remain separate: setup only opens Settings and starts none of them. No tour is
offered on those surfaces or for a remote primary node.

## Focused validation

```sh
bun run --cwd apps/web test src/components/onboarding src/components/settings/settingsRestore.test.ts src/lib/folderDrop.test.ts src/commandPaletteStore.test.ts
bun run --cwd apps/web test:browser src/components/onboarding/OnboardingCoordinator.browser.tsx src/components/settings/ProviderSignInSection.browser.tsx src/components/ChatView.Navigation.browser.tsx
bun run --cwd apps/desktop test src/clientPersistence.test.ts
bun run --cwd packages/shared test src/providerSignIn.test.ts
```

`packages/shared/src/providerSignIn.test.ts` covers `canOfferProviderSignIn`, which decides which
providers setup (and the mobile app's Provider accounts screen) offers **Sign in** for.
