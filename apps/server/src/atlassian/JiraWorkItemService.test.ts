import { AtlassianConnectionId, ProjectId } from "@ryco/contracts";
import { assert, it, vi } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import { AtlassianConnectionRepository } from "../persistence/Services/AtlassianConnections.ts";
import type { AtlassianConnectionRecord } from "../persistence/Services/AtlassianConnections.ts";
import { ProjectAtlassianLinkRepository } from "../persistence/Services/ProjectAtlassianLinks.ts";
import type { ProjectAtlassianLinkRecord } from "../persistence/Services/ProjectAtlassianLinks.ts";
import { JiraWorkItemService, layer as JiraWorkItemServiceLive } from "./JiraWorkItemService.ts";
import { manualJiraTokenSecretName } from "./AtlassianConnectionService.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function connectedJiraConnection(connectionId: AtlassianConnectionId): AtlassianConnectionRecord {
  const timestamp = "2026-06-08T00:00:00.000Z";
  return {
    connectionId,
    kind: "jira_token",
    label: "Jira",
    status: "connected",
    products: ["jira"],
    capabilities: ["jira:read", "jira:write"],
    accountName: null,
    accountEmail: "jira@example.com",
    avatarUrl: null,
    baseUrl: "https://ryco-app.atlassian.net",
    expiresAt: null,
    lastVerifiedAt: null,
    readonly: false,
    isDefault: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function basicAuthorization(email: string, token: string): string {
  return `Basic ${Buffer.from(`${email}:${token}`, "utf8").toString("base64")}`;
}

function requestJsonBody(request: HttpClientRequest.HttpClientRequest): unknown {
  const rawBody = (request.body as { readonly body?: Uint8Array }).body;
  assert.ok(rawBody);
  return JSON.parse(textDecoder.decode(rawBody));
}

function makeLayer(input: {
  readonly connection: AtlassianConnectionRecord;
  readonly projectLink?: ProjectAtlassianLinkRecord;
  readonly token: string;
  readonly response: (request: HttpClientRequest.HttpClientRequest) => Response;
}) {
  const execute = vi.fn((request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, input.response(request))),
  );

  const layer = JiraWorkItemServiceLive.pipe(
    Layer.provide(
      Layer.mock(AtlassianConnectionRepository)({
        getById: ({ connectionId }) =>
          Effect.succeed(
            connectionId === input.connection.connectionId
              ? Option.some(input.connection)
              : Option.none(),
          ),
        list: () => Effect.succeed([input.connection]),
        upsert: () => Effect.void,
        disconnect: () => Effect.succeed(false),
        deleteById: () => Effect.void,
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectAtlassianLinkRepository)({
        getByProjectId: ({ projectId }) =>
          Effect.succeed(
            input.projectLink && projectId === input.projectLink.projectId
              ? Option.some(input.projectLink)
              : Option.none(),
          ),
        upsert: () => Effect.die("unexpected project link upsert"),
        deleteByProjectId: () => Effect.die("unexpected project link delete"),
        clearConnectionReferences: () =>
          Effect.die("unexpected project link connection reference clear"),
      }),
    ),
    Layer.provide(
      Layer.mock(ServerSecretStore)({
        get: (name) =>
          Effect.succeed(
            name === manualJiraTokenSecretName(input.connection.connectionId)
              ? textEncoder.encode(input.token)
              : null,
          ),
        set: () => Effect.void,
        getOrCreateRandom: (_name, bytes) => Effect.succeed(new Uint8Array(bytes)),
        remove: () => Effect.void,
      }),
    ),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => execute(request)),
      ),
    ),
  );

  return { execute, layer };
}

function projectLink(input: {
  readonly connectionId: AtlassianConnectionId;
  readonly projectId: ProjectId;
}): ProjectAtlassianLinkRecord {
  const timestamp = "2026-06-08T00:00:00.000Z";
  return {
    projectId: input.projectId,
    jiraConnectionId: input.connectionId,
    bitbucketConnectionId: null,
    jiraCloudId: null,
    jiraSiteUrl: "https://ryco-app.atlassian.net",
    jiraProjectKeys: ["KAN"],
    bitbucketWorkspace: null,
    bitbucketRepoSlug: null,
    defaultIssueTypeName: null,
    branchNameTemplate: "{issueKey}-{titleSlug}",
    commitMessageTemplate: "{issueKey}: {summary}",
    pullRequestTitleTemplate: "{issueKey}: {summary}",
    smartLinkingEnabled: true,
    autoAttachWorkItems: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

it.effect("lists Jira projects from a saved manual Jira token", () => {
  const connectionId = AtlassianConnectionId.make("atl-jira-1");
  const connection = connectedJiraConnection(connectionId);
  const { execute, layer } = makeLayer({
    connection,
    token: "jira-secret",
    response: () =>
      Response.json({
        values: [
          {
            key: "KAN",
            name: "Mein Software-Team",
            projectTypeKey: "software",
            simplified: true,
            avatarUrls: {
              "48x48": "https://avatar.test/KAN.png",
            },
          },
        ],
      }),
  });

  return Effect.gen(function* () {
    const service = yield* JiraWorkItemService;
    const projects = yield* service.listProjects({
      connectionId,
      siteUrl: "https://ryco-app.atlassian.net/",
    });

    assert.deepStrictEqual(projects, [
      {
        provider: "jira",
        key: "KAN",
        name: "Mein Software-Team",
        url: "https://ryco-app.atlassian.net/jira/software/projects/KAN",
        projectTypeKey: "software",
        simplified: true,
        avatarUrl: "https://avatar.test/KAN.png",
      },
    ]);
    assert.strictEqual(execute.mock.calls.length, 1);
    const request = execute.mock.calls[0]?.[0];
    assert.ok(request);
    const url = new URL(request.url);
    assert.strictEqual(url.origin, "https://ryco-app.atlassian.net");
    assert.strictEqual(url.pathname, "/rest/api/3/project/search");
    assert.deepStrictEqual(request.urlParams.params, [["maxResults", "100"]]);
    assert.strictEqual(
      request.headers.authorization,
      basicAuthorization("jira@example.com", "jira-secret"),
    );
  }).pipe(Effect.provide(layer));
});

it.effect("returns Jira status names separately from normalized state categories", () => {
  const connectionId = AtlassianConnectionId.make("atl-jira-1");
  const projectId = ProjectId.make("project-jira-1");
  const connection = connectedJiraConnection(connectionId);
  const { execute, layer } = makeLayer({
    connection,
    projectLink: projectLink({ connectionId, projectId }),
    token: "jira-secret",
    response: () =>
      Response.json({
        issues: [
          {
            id: "10001",
            key: "KAN-4",
            fields: {
              summary: "Custom workflow status",
              status: {
                name: "Next to come",
                statusCategory: {
                  key: "new",
                  name: "To Do",
                },
              },
              issuetype: { name: "Story" },
              assignee: null,
              updated: "2026-06-08T12:00:00.000Z",
            },
          },
        ],
      }),
  });

  return Effect.gen(function* () {
    const service = yield* JiraWorkItemService;
    const items = yield* service.list({
      projectId,
      state: "open",
      limit: 10,
    });

    assert.strictEqual(items[0]?.state, "open");
    assert.strictEqual(items[0]?.stateName, "Next to come");
    const request = execute.mock.calls[0]?.[0];
    assert.ok(request);
    const rawBody = (request.body as { readonly body?: Uint8Array }).body;
    assert.ok(rawBody);
    assert.include(textDecoder.decode(rawBody), "statusCategory != Done");
  }).pipe(Effect.provide(layer));
});

it.effect("maps Jira detail labels, priority icons, comments, edit metadata, and activity", () => {
  const connectionId = AtlassianConnectionId.make("atl-jira-1");
  const projectId = ProjectId.make("project-jira-1");
  const connection = connectedJiraConnection(connectionId);
  const { layer } = makeLayer({
    connection,
    projectLink: projectLink({ connectionId, projectId }),
    token: "jira-secret",
    response: (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/comment")) {
        return Response.json({
          comments: [
            {
              id: "10000",
              author: { displayName: "Alice" },
              body: {
                type: "doc",
                version: 1,
                content: [{ type: "paragraph", content: [{ type: "text", text: "Looks good" }] }],
              },
              created: "2026-06-08T12:30:00.000Z",
              updated: "2026-06-08T12:45:00.000Z",
            },
          ],
        });
      }
      if (url.pathname.endsWith("/transitions")) {
        return Response.json({ transitions: [] });
      }
      if (url.pathname.endsWith("/editmeta")) {
        return Response.json({
          fields: {
            priority: {
              name: "Priority",
              required: false,
              operations: ["set"],
              allowedValues: [
                {
                  id: "1",
                  name: "High",
                  iconUrl: "https://ryco-app.atlassian.net/images/icons/priorities/high.svg",
                  statusColor: "#f15c75",
                },
              ],
            },
            customfield_10015: {
              name: "Start date",
              required: false,
              operations: ["set"],
            },
          },
        });
      }
      if (url.pathname.endsWith("/changelog")) {
        return Response.json({
          values: [
            {
              id: "20000",
              author: { displayName: "Bob" },
              created: "2026-06-08T13:00:00.000Z",
              items: [{ field: "priority", fromString: "Medium", toString: "High" }],
            },
          ],
        });
      }
      return Response.json({
        id: "10001",
        key: "KAN-4",
        fields: {
          summary: "Mapped Jira detail",
          status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
          issuetype: { name: "Story" },
          priority: {
            id: "1",
            name: "High",
            iconUrl: "https://ryco-app.atlassian.net/images/icons/priorities/high.svg",
            statusColor: "#f15c75",
          },
          assignee: { displayName: "Alice" },
          reporter: { displayName: "Bob" },
          labels: ["frontend", "jira"],
          duedate: "2026-06-30",
          customfield_10015: "2026-06-10",
          updated: "2026-06-08T12:00:00.000Z",
          description: {
            type: "doc",
            version: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text: "Description" }] }],
          },
          parent: { key: "KAN-1" },
        },
      });
    },
  });

  return Effect.gen(function* () {
    const service = yield* JiraWorkItemService;
    const detail = yield* service.get({ projectId, key: "KAN-4", fullContent: true });

    assert.deepStrictEqual(detail.labels, ["frontend", "jira"]);
    assert.strictEqual(detail.priorityDetail?.iconUrl?.endsWith("high.svg"), true);
    assert.strictEqual(detail.dueDate, "2026-06-30");
    assert.strictEqual(detail.startDate, "2026-06-10");
    assert.strictEqual(detail.comments[0]?.id, "10000");
    assert.strictEqual(detail.comments[0]?.editable, true);
    assert.deepStrictEqual(
      detail.editableFields.map((field) => field.id),
      ["priority", "startDate"],
    );
    assert.strictEqual(detail.activity[0]?.items[0]?.to, "High");
  }).pipe(Effect.provide(layer));
});

it.effect("ignores non-string Jira custom fields when mapping detail", () => {
  const connectionId = AtlassianConnectionId.make("atl-jira-1");
  const projectId = ProjectId.make("project-jira-1");
  const connection = connectedJiraConnection(connectionId);
  const { layer } = makeLayer({
    connection,
    projectLink: projectLink({ connectionId, projectId }),
    token: "jira-secret",
    response: (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/comment")) return Response.json({ comments: [] });
      if (url.pathname.endsWith("/transitions")) return Response.json({ transitions: [] });
      if (url.pathname.endsWith("/editmeta")) return Response.json({ fields: {} });
      if (url.pathname.endsWith("/changelog")) return Response.json({ values: [] });
      return Response.json({
        id: "10001",
        key: "KAN-4",
        fields: {
          summary: "Detail with site-specific custom fields",
          status: { name: "To Do", statusCategory: { key: "new" } },
          assignee: null,
          updated: "2026-06-08T12:00:00.000Z",
          description: "Description",
          customfield_10014: { value: "Not an epic key on this site" },
          customfield_10015: ["2026-06-10"],
        },
      });
    },
  });

  return Effect.gen(function* () {
    const service = yield* JiraWorkItemService;
    const detail = yield* service.get({ projectId, key: "KAN-4", fullContent: true });

    assert.strictEqual(detail.title, "Detail with site-specific custom fields");
    assert.strictEqual(detail.epicKey, undefined);
    assert.strictEqual(detail.startDate, undefined);
  }).pipe(Effect.provide(layer));
});

it.effect("enriches editable assignee metadata from Jira assignable users", () => {
  const connectionId = AtlassianConnectionId.make("atl-jira-1");
  const projectId = ProjectId.make("project-jira-1");
  const connection = connectedJiraConnection(connectionId);
  const { execute, layer } = makeLayer({
    connection,
    projectLink: projectLink({ connectionId, projectId }),
    token: "jira-secret",
    response: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/rest/api/3/user/assignable/search") {
        return Response.json([
          {
            accountId: "acct-alice",
            displayName: "Alice",
            avatarUrls: { "24x24": "https://avatar.test/alice.png" },
          },
          {
            accountId: "acct-bob",
            displayName: "Bob",
          },
        ]);
      }
      if (url.pathname.endsWith("/comment")) return Response.json({ comments: [] });
      if (url.pathname.endsWith("/transitions")) return Response.json({ transitions: [] });
      if (url.pathname.endsWith("/editmeta")) {
        return Response.json({
          fields: {
            assignee: {
              name: "Assignee",
              required: false,
              operations: ["set"],
            },
          },
        });
      }
      if (url.pathname.endsWith("/changelog")) return Response.json({ values: [] });
      return Response.json({
        id: "10001",
        key: "KAN-4",
        fields: {
          summary: "Assignable Jira detail",
          status: { name: "To Do", statusCategory: { key: "new" } },
          assignee: { accountId: "acct-alice", displayName: "Alice" },
          updated: "2026-06-08T12:00:00.000Z",
          description: "Description",
        },
      });
    },
  });

  return Effect.gen(function* () {
    const service = yield* JiraWorkItemService;
    const detail = yield* service.get({ projectId, key: "KAN-4", fullContent: true });

    const assigneeField = detail.editableFields.find((field) => field.id === "assignee");
    assert.ok(assigneeField);
    assert.deepStrictEqual(assigneeField.options, [
      {
        accountId: "acct-alice",
        name: "Alice",
        displayName: "Alice",
        avatarUrl: "https://avatar.test/alice.png",
      },
      {
        accountId: "acct-bob",
        name: "Bob",
        displayName: "Bob",
      },
    ]);
    const assignableRequest = execute.mock.calls
      .map((call) => call[0])
      .find((request) => new URL(request.url).pathname === "/rest/api/3/user/assignable/search");
    assert.ok(assignableRequest);
    assert.deepStrictEqual(assignableRequest.urlParams.params, [
      ["issueKey", "KAN-4"],
      ["maxResults", "50"],
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("builds Jira issue update payloads from edit metadata and refetches detail", () => {
  const connectionId = AtlassianConnectionId.make("atl-jira-1");
  const projectId = ProjectId.make("project-jira-1");
  const connection = connectedJiraConnection(connectionId);
  const { execute, layer } = makeLayer({
    connection,
    projectLink: projectLink({ connectionId, projectId }),
    token: "jira-secret",
    response: (request) => {
      const url = new URL(request.url);
      if (request.method === "PUT" && url.pathname === "/rest/api/3/issue/KAN-4") {
        return new Response(null, { status: 204 });
      }
      if (url.pathname.endsWith("/editmeta")) {
        return Response.json({
          fields: {
            assignee: {
              name: "Assignee",
              required: false,
              operations: ["set"],
              allowedValues: [{ accountId: "acct-alice", displayName: "Alice" }],
            },
            priority: {
              name: "Priority",
              required: false,
              operations: ["set"],
              allowedValues: [{ id: "2", name: "Medium" }],
            },
            duedate: { name: "Due date", required: false, operations: ["set"] },
            customfield_10015: { name: "Start date", required: false, operations: ["set"] },
            description: { name: "Description", required: false, operations: ["set"] },
          },
        });
      }
      if (url.pathname.endsWith("/comment")) return Response.json({ comments: [] });
      if (url.pathname.endsWith("/transitions")) return Response.json({ transitions: [] });
      if (url.pathname.endsWith("/changelog")) return Response.json({ values: [] });
      return Response.json({
        id: "10001",
        key: "KAN-4",
        fields: {
          summary: "Updated Jira detail",
          status: { name: "To Do", statusCategory: { key: "new" } },
          assignee: { displayName: "Alice" },
          priority: { id: "2", name: "Medium" },
          updated: "2026-06-08T12:00:00.000Z",
          description: "Updated description",
        },
      });
    },
  });

  return Effect.gen(function* () {
    const service = yield* JiraWorkItemService;
    const detail = yield* service.update({
      projectId,
      key: "KAN-4",
      fields: {
        assigneeAccountId: "acct-alice",
        priorityId: "2",
        dueDate: "2026-06-30",
        startDate: "2026-06-10",
        description: "Updated description",
      },
    });

    assert.strictEqual(detail.title, "Updated Jira detail");
    const updateRequest = execute.mock.calls
      .map((call) => call[0])
      .find(
        (request) =>
          request.method === "PUT" && new URL(request.url).pathname === "/rest/api/3/issue/KAN-4",
      );
    assert.ok(updateRequest);
    assert.deepStrictEqual(requestJsonBody(updateRequest), {
      fields: {
        assignee: { accountId: "acct-alice" },
        priority: { id: "2" },
        duedate: "2026-06-30",
        customfield_10015: "2026-06-10",
        description: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Updated description" }],
            },
          ],
        },
      },
    });
  }).pipe(Effect.provide(layer));
});
