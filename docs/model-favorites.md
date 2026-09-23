# Model favorites

Favorites belong to a provider instance, model, and optional reasoning effort. Two efforts for the same model remain separate presets. Existing favorites without effort remain model-only shortcuts; they do not replace a provider instance's saved options when selected.

In provider tabs, the active model can be starred with its selected effort. Other rows are model-only shortcuts and do not display the active model's effort. A historical model-only star remains removable from its provider tab. The Favorites tab shows each stored preset separately, using the provider's effort label. Unsupported saved efforts are marked unavailable and never applied; the destination's supported current/default effort is used instead. Unrelated supported options come from the destination instance, not the provider being left.

Stars in provider settings update this client's favorites, including when the settings page targets a node; they do not write node configuration. Favorites remain client-local. Native menus use the same identity and capability rules; their destination selection is supplied by the native model picker.

## Older versions and rollback

Forward migration is lossless: the optional effort field does not assign an effort to historical favorites. Current readers retain different efforts and deduplicate identical entries when presenting or editing favorites.

An older version that only knows `{provider, model}` cannot preserve effort presets. Its Effect schema ignores `reasoningEffort`; Low and High for the same model become duplicate model-only entries. Its old single-entry removal then leaves another star, and saving with that version permanently loses the effort information. This has been reproduced with the exact previous favorite schema and removal algorithm in a compatibility regression, not by launching an older app binary.

Do not use an older build to edit favorites if their effort information must be retained. Reopening the current build can deduplicate the resulting model-only entries, but cannot recover efforts that an older build discarded.
