import { describe, expect, it } from "@effect/vitest";
import {
  AGENT_CONTROL_ERROR_MESSAGE_MAX_CHARS,
  AgentControlClientExecutorId,
  ProjectId,
  ProviderInstanceId,
  type AgentControlImportProjectPlan,
  type AgentControlProposalId,
} from "@ryco/contracts";
import { ProjectImportId, ProjectImportStartInput } from "@ryco/contracts/project-copy";
import { Schema } from "effect";

import {
  agentControlClientExecutorIdHash,
  agentControlClientExecutorMatches,
  agentControlProjectImportId,
  agentControlProjectImportInput,
  boundedProjectCopyText,
  describeProjectDestinationProblem,
  hasParentDirectorySegment,
  isAgentControlClientExecutedKind,
  projectCopyFolderNameFromRemote,
  uuidV5,
} from "./projectCopyControl.ts";

describe("projectCopyControl", () => {
  it("derives RFC 4122 version 5 UUIDs", () => {
    // The RFC's DNS namespace example.
    expect(uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "www.example.com")).toBe(
      "2ed6657d-e927-568b-95e1-2665a8aea6a2",
    );
  });

  it("gives an approved import one stable, decodable import id per operation", () => {
    const first = agentControlProjectImportId("0b6d4f0e-8f43-4d1a-9b55-55a1c0f2a1d3");
    expect(first).toBe(agentControlProjectImportId("0b6d4f0e-8f43-4d1a-9b55-55a1c0f2a1d3"));
    expect(first).not.toBe(agentControlProjectImportId("6f0a4c1e-2b3d-4e5f-8a9b-0c1d2e3f4a5b"));
    expect(Schema.is(ProjectImportId)(first)).toBe(true);
    expect(first[14]).toBe("5");
    // Operation ids that are not UUIDs still get one.
    expect(Schema.is(ProjectImportId)(agentControlProjectImportId("operation-test"))).toBe(true);
  });

  it("builds a valid import job input from the plan", () => {
    const plan: AgentControlImportProjectPlan = {
      kind: "importProject",
      projectId: ProjectId.make("project-agent-1"),
      title: "ryco",
      destinationPath: "/Users/me/Code/ryco",
      remoteUrl: "git@github.com:me/ryco.git",
      branch: "main",
      setup: { command: "bun install", saveAsScript: true },
      followUpThread: {
        title: "Finish setting up ryco",
        prompt: "Install the toolchain.",
        runtimeMode: "approval-required",
        envMode: "local",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
      },
    };
    const input = agentControlProjectImportInput(plan, {
      importId: agentControlProjectImportId("operation-1"),
      proposalId: "proposal-1" as AgentControlProposalId,
    });
    expect(Schema.decodeUnknownSync(ProjectImportStartInput)(input)).toEqual(input);
    expect(input.source).toEqual({
      kind: "clone",
      remoteUrl: "git@github.com:me/ryco.git",
      remoteName: "origin",
    });
    expect(input.checkout).toEqual({ branch: "main", headOid: null });
    expect(input.origin).toEqual({
      kind: "agent-control",
      sourceLabel: null,
      proposalId: "proposal-1",
    });
    expect(
      agentControlProjectImportInput(
        { ...plan, branch: null },
        { importId: input.importId, proposalId: "p" as AgentControlProposalId },
      ).checkout,
    ).toBeNull();
  });

  it("binds executors by hash only, compared in constant time", () => {
    const executorId = AgentControlClientExecutorId.make("1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b");
    const other = AgentControlClientExecutorId.make("2f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b");
    const hash = agentControlClientExecutorIdHash(executorId);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(executorId);
    expect(agentControlClientExecutorMatches(hash, executorId)).toBe(true);
    expect(agentControlClientExecutorMatches(hash, other)).toBe(false);
    expect(agentControlClientExecutorMatches("", executorId)).toBe(false);
  });

  it("knows which kinds the approving client executes", () => {
    expect(isAgentControlClientExecutedKind("copyProjectToNode")).toBe(true);
    expect(isAgentControlClientExecutedKind("importProject")).toBe(false);
    expect(isAgentControlClientExecutedKind("createThreads")).toBe(false);
  });

  it("redacts credentials and bounds reported text", () => {
    const text = boundedProjectCopyText(
      "clone of https://me:hunter2@example.com/r.git and ssh://git:pw@host/r failed ghp_abcdefghijklmnop rycoac_" +
        "a".repeat(43),
      "fallback",
    );
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain(":pw@");
    expect(text).not.toContain("ghp_abcdefghijklmnop");
    expect(text).not.toContain("rycoac_a");
    expect(boundedProjectCopyText("   ", "fallback")).toBe("fallback");
    expect(boundedProjectCopyText(null, "fallback")).toBe("fallback");
    expect(boundedProjectCopyText("x".repeat(5_000), "fallback")).toHaveLength(
      AGENT_CONTROL_ERROR_MESSAGE_MAX_CHARS,
    );
  });

  it("names a clone's folder after its repository", () => {
    expect(projectCopyFolderNameFromRemote("git@github.com:me/ryco.git")).toBe("ryco");
    expect(projectCopyFolderNameFromRemote("https://github.com/me/my repo.git/")).toBe("my-repo");
    expect(projectCopyFolderNameFromRemote("ssh://git@host/team/app")).toBe("app");
    expect(projectCopyFolderNameFromRemote("https://host/.git")).toBeNull();
  });

  it("refuses parent segments in destinations", () => {
    expect(hasParentDirectorySegment("~/Code/../secrets")).toBe(true);
    expect(hasParentDirectorySegment("C:\\Code\\..\\x")).toBe(true);
    expect(hasParentDirectorySegment("~/Code/my..app")).toBe(false);
  });

  it("explains an unusable destination with its free alternative", () => {
    expect(
      describeProjectDestinationProblem({
        resolvedPath: "/code/ryco",
        state: "exists-not-empty",
        existingProjectId: null,
        existingRepositoryCanonicalKey: null,
        suggestedPath: "/code/ryco-2",
        detail: null,
      }),
    ).toBe("/code/ryco already exists and is not empty. /code/ryco-2 is free.");
  });
});
