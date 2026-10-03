import { DateTime, Result } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  AZURE_PULL_REQUEST_21_AUTO_COMPLETE,
  AZURE_PULL_REQUEST_22,
  AZURE_PULL_REQUEST_LIST,
} from "./azureDevOpsPullRequestPage.fixtures.ts";
import {
  azureDevOpsReviewDecisionFromVotes,
  decodeAzureDevOpsPullRequestJson,
  decodeAzureDevOpsPullRequestListJson,
  decodeAzureDevOpsRawPullRequestJson,
} from "./azureDevOpsPullRequests.ts";

describe("decodeAzureDevOpsPullRequestListJson (official list sample)", () => {
  it("normalizes rows with author, head, mergeability and labels", () => {
    const result = decodeAzureDevOpsPullRequestListJson(JSON.stringify(AZURE_PULL_REQUEST_LIST));
    expect(Result.isSuccess(result)).toBe(true);
    if (!Result.isSuccess(result)) return;
    const [first] = result.success;
    expect(result.success.map((row) => row.number)).toEqual([22, 21, 1]);
    expect(first).toMatchObject({
      number: 22,
      baseRefName: "new_feature",
      headRefName: "npaulk/my_work",
      state: "open",
      author: "fabrikamfiber16@hotmail.com",
      mergeability: "mergeable",
      // Votes without required reviewers carry no verdict.
      reviewDecision: null,
    });
    expect(first?.headSha).toMatch(/^[0-9a-f]{40}$/u);
    expect(first?.createdAt ? DateTime.formatIso(first.createdAt) : null).toMatch(/^2016-11-01T/u);
  });

  it("skips malformed rows instead of failing the page", () => {
    const result = decodeAzureDevOpsPullRequestListJson(
      JSON.stringify([{ pullRequestId: 0 }, AZURE_PULL_REQUEST_LIST[0]]),
    );
    expect(Result.isSuccess(result) && result.success.map((row) => row.number)).toEqual([22]);
  });
});

describe("decodeAzureDevOpsPullRequestJson", () => {
  it("builds the web URL from the repository clone URL when the CLI omits _links.web", () => {
    const result = decodeAzureDevOpsPullRequestJson(JSON.stringify(AZURE_PULL_REQUEST_22));
    expect(Result.isSuccess(result) && result.success.url).toBe(
      "https://dev.azure.com/fabrikam/_git/2016_10_31/pullrequest/22",
    );
    const withCredentials = decodeAzureDevOpsPullRequestJson(
      JSON.stringify({
        ...AZURE_PULL_REQUEST_22,
        repository: {
          ...AZURE_PULL_REQUEST_22.repository,
          remoteUrl: "https://fabrikam@dev.azure.com/fabrikam/_git/2016_10_31",
        },
      }),
    );
    expect(Result.isSuccess(withCredentials) && withCredentials.success.url).toBe(
      "https://dev.azure.com/fabrikam/_git/2016_10_31/pullrequest/22",
    );
    const withLink = decodeAzureDevOpsPullRequestJson(
      JSON.stringify({
        ...AZURE_PULL_REQUEST_22,
        _links: { web: { href: "https://dev.azure.com/fabrikam/p/_git/r/pullrequest/22" } },
      }),
    );
    expect(Result.isSuccess(withLink) && withLink.success.url).toBe(
      "https://dev.azure.com/fabrikam/p/_git/r/pullrequest/22",
    );
  });

  it("keeps the raw pull request for page operations", () => {
    const result = decodeAzureDevOpsRawPullRequestJson(
      JSON.stringify(AZURE_PULL_REQUEST_21_AUTO_COMPLETE),
    );
    expect(Result.isSuccess(result)).toBe(true);
    if (!Result.isSuccess(result)) return;
    expect(result.success.autoCompleteSetBy?.id).toBe("d6245f20-2af8-44f4-9451-8107cb2767db");
    expect(result.success.completionOptions?.deleteSourceBranch).toBe(true);
    expect(result.success.repository?.project?.id).toBe("a7573007-bbb3-4341-b726-0c4148a07853");
  });

  it("rejects pull request JSON without the identifying fields", () => {
    expect(Result.isSuccess(decodeAzureDevOpsPullRequestJson('{"title":"x"}'))).toBe(false);
  });
});

describe("azureDevOpsReviewDecisionFromVotes", () => {
  it("reads negative votes and required reviewers", () => {
    expect(azureDevOpsReviewDecisionFromVotes([{ vote: -10 }, { vote: 10 }])).toBe(
      "changes_requested",
    );
    expect(azureDevOpsReviewDecisionFromVotes([{ vote: 10, isRequired: true }])).toBe("approved");
    expect(
      azureDevOpsReviewDecisionFromVotes([
        { vote: 10, isRequired: true },
        { vote: 0, isRequired: true },
      ]),
    ).toBe("review_required");
    expect(azureDevOpsReviewDecisionFromVotes([{ vote: 5 }])).toBeNull();
  });
});
