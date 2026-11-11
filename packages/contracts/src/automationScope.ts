/**
 * The scope of a node's automations without a project ("No project"), in place of a project id.
 * A run of one starts a new chat without a project (its own folder, like "New chat without a
 * project"), or, with a `target`, queues into one existing chat without a project. Never a real
 * project's id: the decider refuses to create a project with it.
 *
 * A plain value with no schemas, so `@ryco/shared/projectKind` reads it without the Agent
 * Control schemas; `./agentControl.ts` re-exports it.
 */
import type { ProjectId } from "./baseSchemas.ts";

export const AGENT_CONTROL_CHATS_AUTOMATION_PROJECT_ID = "ryco:chats" as ProjectId;
