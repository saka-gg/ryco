# Settings navigation, previews, and quit protection

Approved direction: retain the desktop/web settings modal and expand the active category into section links. Links follow the rendered sections so unavailable controls never gain a separate navigation path. Scrolling tracks the current section; search navigates to matching controls. General is divided into behavior, projects and threads, confirmations, notifications, and about. Appearance leads with large color-mode previews and a theme gallery rendered from the actual theme tokens, followed by typography and interface controls. Existing custom-theme operations remain available.

Desktop quit protection is a device preference: press twice (default, 1.5 seconds), hold (1 second, confirm on release), or immediately. The main process owns shortcut detection, ignores auto-repeat for double presses, cancels on blur, and leaves explicit menu quit and update/restart paths available. The renderer displays progress only. macOS uses Command-Q; Windows/Linux use Control-Q.

User timeline image attachments retain their intrinsic proportions within bounded thumbnail sizes, without cropping or equal-height grid stretching. Existing lazy loading and expanded-image navigation remain.

Scope excludes the frozen web phone presentation and native mobile screens. Validation covers focused settings and attachment browser tests, desktop quit state-machine tests, persisted preferences, and affected-package typechecking.

## Follow-up: diff presentation and integration categories

Appearance includes visual Unified and Split diff choices. A validated local appearance preference is shared by the settings page and diff toolbar, including already-open panels. The phone diff presentation continues to use unified layout. Previews show the same code edit with addition and deletion colors and explicit plus/minus markers.

MCP is a separate navigation destination for provider-native server configuration. Integrations groups Private Agent Control, Computer Use, and Browser Use. Desktop capabilities control whether local device sections mount; hosted ownership gates remain unchanged. The old Computer Use destination redirects to Integrations when the device capability is present. The frozen phone settings inventory is unchanged.
