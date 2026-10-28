# Quick start

```bash
# Development (with hot reload)
bun run dev

# Desktop development
bun run dev:desktop

# In a linked git worktree, dev commands get their own state (~/.ryco/dev-homes/<worktree>-<hash>),
# ports and a seeded copy of your dev projects automatically. To pick another port set:
RYCO_DEV_INSTANCE=feature-xyz bun run dev:desktop

# Production
bun run build
bun run start

# Build a shareable macOS .dmg (arm64 by default)
bun run dist:desktop:dmg

# Or from any project directory after publishing:
npx ryco-cli
```
