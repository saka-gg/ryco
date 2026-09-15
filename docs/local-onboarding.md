# Local first-run onboarding

Desktop and browsers connected to a loopback Ryco server offer a short setup flow after the
current workspace and client settings have loaded. It shows provider discovery and authentication
status, opens the existing project picker, and introduces tasks, review, and Settings.

Use **Provider settings** to configure an instance. Provider authentication remains with each
provider's own CLI or existing settings workflow. Setup does not install a CLI, start a sign-in,
change accounts, or enable/disable providers automatically. **Refresh discovery** explicitly
rechecks status; unverified authentication remains labeled as such.

**Add project** opens the normal project picker. Closing the picker or Provider settings returns
to the same setup step. Setup writes no project commands of its own. Connection loss disables
setup actions until the current workspace is ready again; it does not change connection recovery.

Choose **Skip setup**, close the dialog, or finish the quick tour to dismiss it. Replay from
**This app / This browser → General → Welcome tour**. Completion is stored per environment through
the existing client-settings persistence: Desktop's local settings file or the browser's local
storage. It is not a node/server preference, survives normal preference resets, and Desktop's
marker does not depend on its backend port. An existing installation with projects is exempted.
If local persistence fails, the in-memory client settings still dismiss setup for that session;
a later launch may offer it again.

Hub/account enrollment, native trust onboarding, hosted lifecycle recovery, and the frozen web
phone surface remain separate. No tour is offered on those surfaces or for a remote primary node.

## Focused validation

```sh
bun run --cwd apps/web test src/components/onboarding src/components/settings/settingsRestore.test.ts
bun run --cwd apps/web test:browser src/components/onboarding/OnboardingCoordinator.browser.tsx
bun run --cwd apps/desktop test src/clientPersistence.test.ts
```
