# Device names and settings

Ryco identifies an execution device by its name in settings, the inbox, project selection, and conversation targets. A Hub owner's custom device name takes precedence over the machine's automatic name. Renaming changes display metadata only: environment IDs, projects, conversations, credentials, and connections stay in place. A desktop's direct connection and its Hub entry remain aliases of the same machine; renaming must not create another local workspace.

Owners can rename an enrolled device from its Hub details, desktop device settings, or the native mobile machine list. The Hub name is shared with every authorized client. A device does not need to be online for its Hub metadata to be renamed. Standalone devices use their existing machine name until enrolled; direct pairing labels remain client-local aliases.

Settings have two destinations:

- **App preferences** affect the app being used. Appearance, composer preferences, diff presentation, and similar interface options stay in that desktop app or browser. The desktop identifies these preferences as “Ryco on <device name>”; the web identifies the current browser without guessing a hardware hostname.
- **Device settings** identify the selected device by name. Supported settings are read and written through that device's authorized connection. Switching the selected device never changes the current app's appearance. A device owner may manage supported remote settings; operators and viewers retain their existing access limits.

Computer use and operating system permissions require the native app on the target device. Remote device settings explain where to enable them and never mount the current desktop's native permission controls. Opening settings does not request system permissions; permission checks and changes remain explicit actions. Connection security remains under Connections → Advanced.

Name lookup uses existing descriptor and directory state. It does not probe the operating system, open additional connections, poll permissions, or restart a device.
