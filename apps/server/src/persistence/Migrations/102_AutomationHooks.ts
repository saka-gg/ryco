import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Webhook triggers for automations (`docs/automation-webhooks.md`).
 *
 * - `automation_hooks`: one hook per webhook schedule, keyed by automation id. `hook_id` is the
 *   public id in its URLs; the secret lives in the server secret store, never here. The last
 *   request's time, path (`cloud` / `direct`) and outcome are what the editor shows.
 * - `automation_hook_deliveries`: the requests a hook took in the last 48 hours, by delivery
 *   key (the delivery id, and GitHub's `X-GitHub-Delivery` when sent), so a request handed over
 *   again runs nothing new. `started` marks the ones that started a run, which the rate limit
 *   counts.
 * - `automation_hook_run_prompts`: the framed prompt of a run a request started, kept beside the
 *   run so a restart that finds it still materializing builds the same proposal.
 * - `automation_hook_hub_state`: the hook ids the Hub took at the last sync, so a node whose last
 *   hook went while it was offline still tells the Hub once.
 *
 * Idempotent: it also runs as a post-migrator repair, because the migrator skips ids at or below
 * the latest applied one and parallel branches may claim the same id. Everything commits
 * together, so a present `automation_hooks` table means the rest exists. Returns whether it was
 * missing.
 */
export const ensureAutomationHookTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const existing = yield* sql`
        SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'automation_hooks'
      `;
      if (existing.length > 0) return false;
      yield* sql`CREATE TABLE automation_hooks (
        automation_id TEXT PRIMARY KEY,
        hook_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        secret_updated_at TEXT NOT NULL,
        last_request_at TEXT,
        last_request_via TEXT,
        last_request_outcome TEXT
      )`;
      yield* sql`CREATE TABLE IF NOT EXISTS automation_hook_deliveries (
        hook_id TEXT NOT NULL,
        delivery_key TEXT NOT NULL,
        received_at TEXT NOT NULL,
        started INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (hook_id, delivery_key)
      )`;
      // The rate limit reads one hook's recent requests; pruning reads the oldest.
      yield* sql`CREATE INDEX IF NOT EXISTS idx_automation_hook_deliveries_hook_received
        ON automation_hook_deliveries(hook_id, received_at)`;
      yield* sql`CREATE INDEX IF NOT EXISTS idx_automation_hook_deliveries_received
        ON automation_hook_deliveries(received_at)`;
      yield* sql`CREATE TABLE IF NOT EXISTS automation_hook_run_prompts (
        run_id TEXT PRIMARY KEY,
        prompt TEXT NOT NULL
      )`;
      yield* sql`CREATE TABLE IF NOT EXISTS automation_hook_hub_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        registered_json TEXT NOT NULL
      )`;
      return true;
    }),
  );
});

export default ensureAutomationHookTables.pipe(Effect.asVoid);
