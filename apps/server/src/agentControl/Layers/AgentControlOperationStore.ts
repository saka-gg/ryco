import { type AgentControlOperation, AgentControlOperationId } from "@ryco/contracts";
import { Effect, Layer, Option } from "effect";

import { AgentControlOperationRepository } from "../../persistence/Services/AgentControlOperations.ts";
import {
  AgentControlInvalidTransitionError,
  AgentControlOperationNotFoundError,
} from "../Errors.ts";
import { AgentControlPolicy } from "../Services/AgentControlPolicy.ts";
import {
  AgentControlOperationStore,
  type AgentControlOperationStoreShape,
} from "../Services/AgentControlOperationStore.ts";
import { operationTransitionIssue } from "../transitions.ts";

const makeAgentControlOperationStore = Effect.gen(function* () {
  const policy = yield* AgentControlPolicy;
  const operations = yield* AgentControlOperationRepository;

  const getOrNotFound = (operationId: AgentControlOperation["operationId"]) =>
    operations.getById({ operationId }).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new AgentControlOperationNotFoundError({ operationId })),
          onSome: Effect.succeed,
        }),
      ),
    );

  const createForProposal: AgentControlOperationStoreShape["createForProposal"] = (input) =>
    Effect.gen(function* () {
      yield* policy.requireEnabled("AgentControlOperationStore.createForProposal");
      if (input.proposal.status !== "executing") {
        return yield* new AgentControlInvalidTransitionError({
          entity: "operation",
          from: input.proposal.status,
          to: "pending",
          actor: "executor",
          detail: "operations may only be created for an executing proposal",
        });
      }

      const operation: AgentControlOperation = {
        operationId: AgentControlOperationId.make(crypto.randomUUID()),
        proposalId: input.proposal.proposalId,
        actionKind: input.proposal.plan.kind,
        status: "pending",
        attempt: 0,
        state: input.state ?? {
          completedSteps: [],
          resources: {
            projectIds: [],
            automationIds: [],
            threadIds: [],
            ownedThreadIds: [],
            worktreeIds: [],
            ownedWorktrees: [],
          },
          commandReceipts: [],
        },
        result: null,
        createdAt: input.now,
        updatedAt: input.now,
      };
      const inserted = yield* operations.insert(operation);
      if (inserted) {
        return { operation, replayed: false };
      }

      // One operation per proposal: a conflict means it already exists.
      const existing = yield* operations.getByProposalId({
        proposalId: input.proposal.proposalId,
      });
      if (Option.isNone(existing)) {
        return yield* new AgentControlOperationNotFoundError({
          operationId: operation.operationId,
        });
      }
      return { operation: existing.value, replayed: true };
    });

  const getByProposalId: AgentControlOperationStoreShape["getByProposalId"] = (proposalId) =>
    operations.getByProposalId({ proposalId });

  const listRecoverable: AgentControlOperationStoreShape["listRecoverable"] = () =>
    operations.listRecoverable();

  const transition: AgentControlOperationStoreShape["transition"] = (input) =>
    Effect.gen(function* () {
      // Fail closed on transitions that advance work. Winding-down
      // transitions (compensating, terminal settles) stay available so
      // restart cleanup can settle stragglers while the gate is off.
      if (input.nextStatus === "running") {
        yield* policy.requireEnabled("AgentControlOperationStore.transition");
      }
      const issue = operationTransitionIssue({
        from: input.expectedStatus,
        to: input.nextStatus,
        actor: input.actor,
      });
      if (issue !== null) {
        return yield* new AgentControlInvalidTransitionError({
          entity: "operation",
          from: input.expectedStatus,
          to: input.nextStatus,
          actor: input.actor,
          detail: issue,
        });
      }

      const won = yield* operations.compareAndSet({
        operationId: input.operationId,
        expectedStatus: input.expectedStatus,
        nextStatus: input.nextStatus,
        attempt: input.attempt,
        state: input.state,
        result: input.result,
        updatedAt: input.updatedAt,
      });
      if (!won) {
        const actual = yield* getOrNotFound(input.operationId);
        return yield* new AgentControlInvalidTransitionError({
          entity: "operation",
          from: actual.status,
          to: input.nextStatus,
          actor: input.actor,
          detail: `lost transition race; operation is now ${actual.status}`,
        });
      }
      return yield* getOrNotFound(input.operationId);
    });

  const checkpoint: AgentControlOperationStoreShape["checkpoint"] = (input) =>
    Effect.gen(function* () {
      const won = yield* operations.compareAndSet({
        operationId: input.operationId,
        expectedStatus: input.expectedStatus,
        nextStatus: input.expectedStatus,
        attempt: input.attempt,
        state: input.state,
        result: null,
        updatedAt: input.updatedAt,
      });
      if (!won) {
        const actual = yield* getOrNotFound(input.operationId);
        return yield* new AgentControlInvalidTransitionError({
          entity: "operation",
          from: actual.status,
          to: input.expectedStatus,
          actor: "executor",
          detail: `lost checkpoint race; operation is now ${actual.status}`,
        });
      }
      return yield* getOrNotFound(input.operationId);
    });

  return {
    createForProposal,
    getByProposalId,
    listRecoverable,
    transition,
    checkpoint,
  } satisfies AgentControlOperationStoreShape;
});

export const AgentControlOperationStoreLive = Layer.effect(
  AgentControlOperationStore,
  makeAgentControlOperationStore,
);
