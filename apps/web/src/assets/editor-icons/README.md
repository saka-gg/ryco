# Original editor app icons

These PNGs are the original launcher-style icons supplied by each application vendor. The only
transformations applied for Ryco are proportional scaling to 256 pixels and trimming transparent
padding so every icon fills the same 232px box and renders at a matching visual size. They are
checked in so the editor picker remains available offline and does not contact vendor CDNs.

Sources retrieved on 2026-08-02:

- `android-studio.png`: Google Android Studio stable artwork at commit
  `9893575f1d7cb452ad2ef4e758f484d8629811df`,
  `studio/stable/studio.png` in `android.googlesource.com/platform/tools/adt/idea`.
- `xcode.png`: `Xcode.icns` from Apple Xcode 26.6 (build 17F112).
- `windsurf.png`: `https://windsurf.com/favicon_512.png`.
- `sublime-text.png`: `https://www.sublimehq.com/images/sublime_text.png`.
- `nova.png`: `https://nova.app/apple-touch-icon.png`.
- `finder.png`: `Finder.icns` from macOS `/System/Library/CoreServices/Finder.app`, downscaled to
  256 pixels.
- `terminal.png`: `Terminal.icns` from macOS `/System/Applications/Utilities/Terminal.app`.
- `windows-terminal.png`: `res/terminal/images/Square150x150Logo.scale-400.png` from
  `github.com/microsoft/terminal` (MIT).
- `explorer.svg`: Windows File Explorer icon,
  [`Windows_Explorer.svg`](https://commons.wikimedia.org/wiki/File:Windows_Explorer.svg) on
  Wikimedia Commons.
- `positron.png`: Positron launcher artwork at commit
  `39d65d7e4a28cbe3c7a75bb6d9ccd3d8ffc87751`,
  `positron-product-icons/positron.icns` in `github.com/posit-dev/positron`.

All product names, icons, and trademarks remain the property of their respective owners and are
used here only to identify the matching application launcher.
