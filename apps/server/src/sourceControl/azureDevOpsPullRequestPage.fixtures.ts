/**
 * Azure DevOps REST payloads for tests, copied verbatim from the official
 * examples (MicrosoftDocs/vsts-rest-api-specs, `specification/<area>/7.1/httpExamples`,
 * the source of the "Sample response" blocks on learn.microsoft.com).
 * Payloads the reference has no example for are built field by field from the
 * documented definitions and say so.
 */

/** Pull Requests - Update ("Update title" sample response): PR 22 after its second push.
 * https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/update?view=azure-devops-rest-7.1 */
export const AZURE_PULL_REQUEST_22 = {
  repository: {
    id: "3411ebc1-d5aa-464f-9615-0b527bc66719",
    name: "2016_10_31",
    url: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719",
    project: {
      id: "a7573007-bbb3-4341-b726-0c4148a07853",
      name: "2016_10_31",
      description: "test project created on Halloween 2016",
      url: "https://dev.azure.com/fabrikam/_apis/projects/a7573007-bbb3-4341-b726-0c4148a07853",
      state: "wellFormed",
      revision: 7,
    },
    remoteUrl: "https://dev.azure.com/fabrikam/_git/2016_10_31",
  },
  pullRequestId: 22,
  codeReviewId: 22,
  status: "active",
  createdBy: {
    id: "d6245f20-2af8-44f4-9451-8107cb2767db",
    displayName: "Normal Paulk",
    uniqueName: "fabrikamfiber16@hotmail.com",
    url: "https://dev.azure.com/fabrikam/_apis/Identities/d6245f20-2af8-44f4-9451-8107cb2767db",
    imageUrl:
      "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=d6245f20-2af8-44f4-9451-8107cb2767db",
  },
  creationDate: "2016-11-01T16:30:31.6655471Z",
  title: "Updated pull request title",
  description: "Adding a new feature",
  sourceRefName: "refs/heads/npaulk/my_work",
  targetRefName: "refs/heads/new_feature",
  mergeStatus: "succeeded",
  mergeId: "f5fc8381-3fb2-49fe-8a0d-27dcc2d6ef82",
  lastMergeSourceCommit: {
    commitId: "8c9396b5cf22f929767c7172e9dbbe777ddc6357",
    url: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/commits/8c9396b5cf22f929767c7172e9dbbe777ddc6357",
  },
  lastMergeTargetCommit: {
    commitId: "f47bbc106853afe3c1b07a81754bce5f4b8dbf62",
    url: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/commits/f47bbc106853afe3c1b07a81754bce5f4b8dbf62",
  },
  lastMergeCommit: {
    commitId: "fd8da3e51efe350811d2157b2223df53d4db46c3",
    author: {
      name: "Normal Paulk",
      email: "fabrikamfiber16@hotmail.com",
      date: "2016-11-01T16:30:40Z",
    },
    committer: {
      name: "Normal Paulk",
      email: "fabrikamfiber16@hotmail.com",
      date: "2016-11-01T16:30:40Z",
    },
    comment: "Merge pull request 22 from npaulk/my_work into new_feature",
    url: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/commits/fd8da3e51efe350811d2157b2223df53d4db46c3",
  },
  reviewers: [
    {
      reviewerUrl:
        "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/pullRequests/22/reviewers/d6245f20-2af8-44f4-9451-8107cb2767db",
      vote: 10,
      id: "d6245f20-2af8-44f4-9451-8107cb2767db",
      displayName: "Normal Paulk",
      uniqueName: "fabrikamfiber16@hotmail.com",
      url: "https://dev.azure.com/fabrikam/_apis/Identities/d6245f20-2af8-44f4-9451-8107cb2767db",
      imageUrl:
        "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=d6245f20-2af8-44f4-9451-8107cb2767db",
    },
  ],
  url: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/pullRequests/22",
  _links: {
    self: {
      href: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/pullRequests/22",
    },
    repository: {
      href: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719",
    },
    workItems: {
      href: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/pullRequests/22/workitems",
    },
    sourceBranch: {
      href: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/refs",
    },
    targetBranch: {
      href: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/refs",
    },
    sourceCommit: {
      href: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/commits/8c9396b5cf22f929767c7172e9dbbe777ddc6357",
    },
    targetCommit: {
      href: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/commits/f47bbc106853afe3c1b07a81754bce5f4b8dbf62",
    },
    createdBy: {
      href: "https://dev.azure.com/fabrikam/_apis/Identities/d6245f20-2af8-44f4-9451-8107cb2767db",
    },
    iterations: {
      href: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/pullRequests/22/iterations",
    },
  },
  supportsIterations: true,
  artifactId:
    "vstfs:///Git/PullRequestId/a7573007-bbb3-4341-b726-0c4148a07853%2f3411ebc1-d5aa-464f-9615-0b527bc66719%2f22",
} as const;

/** Pull Requests - Update ("Enable auto-completion" sample response). */
export const AZURE_PULL_REQUEST_21_AUTO_COMPLETE = {
  repository: {
    id: "3411ebc1-d5aa-464f-9615-0b527bc66719",
    name: "2016_10_31",
    url: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719",
    project: {
      id: "a7573007-bbb3-4341-b726-0c4148a07853",
      name: "2016_10_31",
      description: "test project created on Halloween 2016",
      url: "https://dev.azure.com/fabrikam/_apis/projects/a7573007-bbb3-4341-b726-0c4148a07853",
      state: "wellFormed",
      revision: 7,
    },
    remoteUrl: "https://dev.azure.com/fabrikam/_git/2016_10_31",
  },
  pullRequestId: 21,
  codeReviewId: 21,
  status: "active",
  createdBy: {
    id: "d6245f20-2af8-44f4-9451-8107cb2767db",
    displayName: "Normal Paulk",
    uniqueName: "fabrikamfiber16@hotmail.com",
    url: "https://dev.azure.com/fabrikam/_apis/Identities/d6245f20-2af8-44f4-9451-8107cb2767db",
    imageUrl:
      "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=d6245f20-2af8-44f4-9451-8107cb2767db",
  },
  creationDate: "2016-11-01T16:30:23.8410158Z",
  title: "Added known issues document",
  description: "Added known issues document",
  sourceRefName: "refs/heads/npaulk/known_issues",
  targetRefName: "refs/heads/new_feature",
  mergeStatus: "succeeded",
  mergeId: "58a34c62-01b5-4029-8337-c99782ee9003",
  lastMergeSourceCommit: {
    commitId: "05ce817c4692afc93c1eb952643bdf7ffbab18ee",
    url: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/commits/05ce817c4692afc93c1eb952643bdf7ffbab18ee",
  },
  lastMergeTargetCommit: {
    commitId: "f47bbc106853afe3c1b07a81754bce5f4b8dbf62",
    url: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/commits/f47bbc106853afe3c1b07a81754bce5f4b8dbf62",
  },
  lastMergeCommit: {
    commitId: "bf27525b51b5347483ed9d7dc52ce5a3cf2b045a",
    author: {
      name: "Normal Paulk",
      email: "fabrikamfiber16@hotmail.com",
      date: "2016-11-01T16:30:25Z",
    },
    committer: {
      name: "Normal Paulk",
      email: "fabrikamfiber16@hotmail.com",
      date: "2016-11-01T16:30:25Z",
    },
    comment: "Merge pull request 21 from npaulk/known_issues into new_feature",
    url: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/commits/bf27525b51b5347483ed9d7dc52ce5a3cf2b045a",
  },
  reviewers: [
    {
      reviewerUrl:
        "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/pullRequests/21/reviewers/d6245f20-2af8-44f4-9451-8107cb2767db",
      vote: 0,
      id: "d6245f20-2af8-44f4-9451-8107cb2767db",
      displayName: "Normal Paulk",
      uniqueName: "fabrikamfiber16@hotmail.com",
      url: "https://dev.azure.com/fabrikam/_apis/Identities/d6245f20-2af8-44f4-9451-8107cb2767db",
      imageUrl:
        "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=d6245f20-2af8-44f4-9451-8107cb2767db",
    },
  ],
  url: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/pullRequests/21",
  _links: {
    self: {
      href: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/pullRequests/21",
    },
    repository: {
      href: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719",
    },
    workItems: {
      href: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/pullRequests/21/workitems",
    },
    sourceBranch: {
      href: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/refs",
    },
    targetBranch: {
      href: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/refs",
    },
    sourceCommit: {
      href: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/commits/05ce817c4692afc93c1eb952643bdf7ffbab18ee",
    },
    targetCommit: {
      href: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/commits/f47bbc106853afe3c1b07a81754bce5f4b8dbf62",
    },
    createdBy: {
      href: "https://dev.azure.com/fabrikam/_apis/Identities/d6245f20-2af8-44f4-9451-8107cb2767db",
    },
    iterations: {
      href: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/pullRequests/21/iterations",
    },
  },
  completionOptions: {
    mergeCommitMessage: "Added known issues document",
    deleteSourceBranch: true,
  },
  supportsIterations: true,
  autoCompleteSetBy: {
    id: "d6245f20-2af8-44f4-9451-8107cb2767db",
    displayName: "Normal Paulk",
    uniqueName: "fabrikamfiber16@hotmail.com",
    url: "https://dev.azure.com/fabrikam/_apis/Identities/d6245f20-2af8-44f4-9451-8107cb2767db",
    imageUrl:
      "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=d6245f20-2af8-44f4-9451-8107cb2767db",
  },
  artifactId:
    "vstfs:///Git/PullRequestId/a7573007-bbb3-4341-b726-0c4148a07853%2f3411ebc1-d5aa-464f-9615-0b527bc66719%2f21",
} as const;

/** Pull Requests - Get Pull Requests sample response `value` (what `az repos pr list` prints).
 * https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/get-pull-requests?view=azure-devops-rest-7.1 */
export const AZURE_PULL_REQUEST_LIST = [
  {
    repository: {
      id: "3411ebc1-d5aa-464f-9615-0b527bc66719",
      name: "2016_10_31",
      url: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719",
      project: {
        id: "a7573007-bbb3-4341-b726-0c4148a07853",
        name: "2016_10_31",
        state: "unchanged",
      },
    },
    pullRequestId: 22,
    codeReviewId: 22,
    status: "active",
    createdBy: {
      id: "d6245f20-2af8-44f4-9451-8107cb2767db",
      displayName: "Normal Paulk",
      uniqueName: "fabrikamfiber16@hotmail.com",
      url: "https://dev.azure.com/fabrikam/_apis/Identities/d6245f20-2af8-44f4-9451-8107cb2767db",
      imageUrl:
        "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=d6245f20-2af8-44f4-9451-8107cb2767db",
    },
    creationDate: "2016-11-01T16:30:31.6655471Z",
    title: "A new feature",
    description: "Adding a new feature",
    sourceRefName: "refs/heads/npaulk/my_work",
    targetRefName: "refs/heads/new_feature",
    mergeStatus: "succeeded",
    mergeId: "f5fc8381-3fb2-49fe-8a0d-27dcc2d6ef82",
    lastMergeSourceCommit: {
      commitId: "b60280bc6e62e2f880f1b63c1e24987664d3bda3",
      url: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/commits/b60280bc6e62e2f880f1b63c1e24987664d3bda3",
    },
    lastMergeTargetCommit: {
      commitId: "f47bbc106853afe3c1b07a81754bce5f4b8dbf62",
      url: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/commits/f47bbc106853afe3c1b07a81754bce5f4b8dbf62",
    },
    lastMergeCommit: {
      commitId: "39f52d24533cc712fc845ed9fd1b6c06b3942588",
      url: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/commits/39f52d24533cc712fc845ed9fd1b6c06b3942588",
    },
    reviewers: [
      {
        reviewerUrl:
          "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/pullRequests/22/reviewers/d6245f20-2af8-44f4-9451-8107cb2767db",
        vote: 0,
        id: "d6245f20-2af8-44f4-9451-8107cb2767db",
        displayName: "Normal Paulk",
        uniqueName: "fabrikamfiber16@hotmail.com",
        url: "https://dev.azure.com/fabrikam/_apis/Identities/d6245f20-2af8-44f4-9451-8107cb2767db",
        imageUrl:
          "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=d6245f20-2af8-44f4-9451-8107cb2767db",
      },
    ],
    url: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/pullRequests/22",
    supportsIterations: true,
  },
  {
    repository: {
      id: "3411ebc1-d5aa-464f-9615-0b527bc66719",
      name: "2016_10_31",
      url: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719",
      project: {
        id: "a7573007-bbb3-4341-b726-0c4148a07853",
        name: "2016_10_31",
        state: "unchanged",
      },
    },
    pullRequestId: 21,
    codeReviewId: 21,
    status: "active",
    createdBy: {
      id: "d6245f20-2af8-44f4-9451-8107cb2767db",
      displayName: "Normal Paulk",
      uniqueName: "fabrikamfiber16@hotmail.com",
      url: "https://dev.azure.com/fabrikam/_apis/Identities/d6245f20-2af8-44f4-9451-8107cb2767db",
      imageUrl:
        "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=d6245f20-2af8-44f4-9451-8107cb2767db",
    },
    creationDate: "2016-11-01T16:30:23.8410158Z",
    title: "Added known issues document",
    description: "Added known issues document",
    sourceRefName: "refs/heads/npaulk/known_issues",
    targetRefName: "refs/heads/new_feature",
    mergeStatus: "succeeded",
    mergeId: "58a34c62-01b5-4029-8337-c99782ee9003",
    lastMergeSourceCommit: {
      commitId: "05ce817c4692afc93c1eb952643bdf7ffbab18ee",
      url: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/commits/05ce817c4692afc93c1eb952643bdf7ffbab18ee",
    },
    lastMergeTargetCommit: {
      commitId: "f47bbc106853afe3c1b07a81754bce5f4b8dbf62",
      url: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/commits/f47bbc106853afe3c1b07a81754bce5f4b8dbf62",
    },
    lastMergeCommit: {
      commitId: "bf27525b51b5347483ed9d7dc52ce5a3cf2b045a",
      url: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/commits/bf27525b51b5347483ed9d7dc52ce5a3cf2b045a",
    },
    reviewers: [
      {
        reviewerUrl:
          "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/pullRequests/21/reviewers/d6245f20-2af8-44f4-9451-8107cb2767db",
        vote: 0,
        id: "d6245f20-2af8-44f4-9451-8107cb2767db",
        displayName: "Normal Paulk",
        uniqueName: "fabrikamfiber16@hotmail.com",
        url: "https://dev.azure.com/fabrikam/_apis/Identities/d6245f20-2af8-44f4-9451-8107cb2767db",
        imageUrl:
          "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=d6245f20-2af8-44f4-9451-8107cb2767db",
      },
    ],
    url: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/pullRequests/21",
    supportsIterations: true,
  },
  {
    repository: {
      id: "3411ebc1-d5aa-464f-9615-0b527bc66719",
      name: "2016_10_31",
      url: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719",
      project: {
        id: "a7573007-bbb3-4341-b726-0c4148a07853",
        name: "2016_10_31",
        state: "unchanged",
      },
    },
    pullRequestId: 1,
    codeReviewId: 1,
    status: "active",
    createdBy: {
      id: "d6245f20-2af8-44f4-9451-8107cb2767db",
      displayName: "Normal Paulk",
      uniqueName: "fabrikamfiber16@hotmail.com",
      url: "https://dev.azure.com/fabrikam/_apis/Identities/d6245f20-2af8-44f4-9451-8107cb2767db",
      imageUrl:
        "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=d6245f20-2af8-44f4-9451-8107cb2767db",
    },
    creationDate: "2016-10-31T20:20:32.3087249Z",
    title: "some_branch edit",
    description: " - Updated README.md",
    sourceRefName: "refs/heads/some_branch",
    targetRefName: "refs/heads/master",
    mergeStatus: "succeeded",
    mergeId: "b294fd81-d539-461d-b271-71a6e61f3c24",
    lastMergeSourceCommit: {
      commitId: "34a9e500f29d119802a828d7a759f6fa2e546750",
      url: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/commits/34a9e500f29d119802a828d7a759f6fa2e546750",
    },
    lastMergeTargetCommit: {
      commitId: "f47bbc106853afe3c1b07a81754bce5f4b8dbf62",
      url: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/commits/f47bbc106853afe3c1b07a81754bce5f4b8dbf62",
    },
    lastMergeCommit: {
      commitId: "41e98d9939cf4ec0ce166079c22e2b40de862cf5",
      url: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/commits/41e98d9939cf4ec0ce166079c22e2b40de862cf5",
    },
    reviewers: [
      {
        reviewerUrl:
          "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/pullRequests/1/reviewers/98d08d98-a075-46e7-a81e-21bc6f12cae7",
        vote: 0,
        id: "98d08d98-a075-46e7-a81e-21bc6f12cae7",
        displayName: "[2016_10_31]\\2016_10_31 Team",
        uniqueName:
          "vstfs:///Classification/TeamProject/a7573007-bbb3-4341-b726-0c4148a07853\\2016_10_31 Team",
        url: "https://dev.azure.com/fabrikam/_apis/Identities/98d08d98-a075-46e7-a81e-21bc6f12cae7",
        imageUrl:
          "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=98d08d98-a075-46e7-a81e-21bc6f12cae7",
        isContainer: true,
      },
    ],
    url: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/pullRequests/1",
    supportsIterations: true,
  },
] as const;

/** Pull Request Threads - List sample response.
 * https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-threads/list?view=azure-devops-rest-7.1 */
export const AZURE_THREADS_22 = {
  value: [
    {
      pullRequestThreadContext: null,
      id: 141,
      publishedDate: "2016-11-01T16:30:32.74Z",
      lastUpdatedDate: "2016-11-01T16:30:32.74Z",
      comments: [
        {
          id: 1,
          parentCommentId: 0,
          author: {
            id: "41113706-4320-4083-9150-925feb93fc22",
            displayName: "[DefaultCollection]\\Project Collection Service Accounts",
            url: "https://dev.azure.com/fabrikam/_apis/Identities/41113706-4320-4083-9150-925feb93fc22",
            imageUrl:
              "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=41113706-4320-4083-9150-925feb93fc22",
            isContainer: true,
          },
          content:
            "The pull request is mergable and the target commit would be 39f52d24533cc712fc845ed9fd1b6c06b3942588.",
          publishedDate: "2016-11-01T16:30:32.74Z",
          lastUpdatedDate: "2016-11-01T16:30:32.74Z",
          commentType: "system",
          usersLiked: [],
        },
      ],
      threadContext: null,
      properties: {
        CodeReviewMergeCommit: {
          $type: "System.String",
          $value: "39f52d24533cc712fc845ed9fd1b6c06b3942588",
        },
        CodeReviewMergeStatus: {
          $type: "System.String",
          $value: "Succeeded",
        },
        CodeReviewSourceCommit: {
          $type: "System.String",
          $value: "b60280bc6e62e2f880f1b63c1e24987664d3bda3",
        },
        CodeReviewTargetCommit: {
          $type: "System.String",
          $value: "f47bbc106853afe3c1b07a81754bce5f4b8dbf62",
        },
        CodeReviewThreadType: {
          $type: "System.String",
          $value: "MergeAttempt",
        },
      },
      isDeleted: false,
    },
    {
      pullRequestThreadContext: null,
      id: 142,
      publishedDate: "2016-11-01T16:30:35Z",
      lastUpdatedDate: "2016-11-01T16:30:35Z",
      comments: [
        {
          id: 1,
          parentCommentId: 0,
          author: {
            id: "41113706-4320-4083-9150-925feb93fc22",
            displayName: "[DefaultCollection]\\Project Collection Service Accounts",
            url: "https://dev.azure.com/fabrikam/_apis/Identities/41113706-4320-4083-9150-925feb93fc22",
            imageUrl:
              "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=41113706-4320-4083-9150-925feb93fc22",
            isContainer: true,
          },
          content: "Normal Paulk added Johnnie McLeod as a reviewer",
          publishedDate: "2016-11-01T16:30:35Z",
          lastUpdatedDate: "2016-11-01T16:30:35Z",
          commentType: "system",
          usersLiked: [],
        },
      ],
      threadContext: null,
      properties: {
        CodeReviewThreadType: {
          $type: "System.String",
          $value: "ReviewersUpdate",
        },
        CodeReviewReviewersUpdatedAddedDisplayName: {
          $type: "System.String",
          $value: "Johnnie McLeod",
        },
        CodeReviewReviewersUpdatedAddedTfId: {
          $type: "System.String",
          $value: "2428198325304a9caeb788d60d57acfd",
        },
        CodeReviewReviewersUpdatedByDisplayname: {
          $type: "System.String",
          $value: "Normal Paulk",
        },
        CodeReviewReviewersUpdatedByTfId: {
          $type: "System.String",
          $value: "b335b0d4578f4944b94ca45216eb1a1a",
        },
        CodeReviewReviewersUpdatedNumAdded: {
          $type: "System.Int32",
          $value: 1,
        },
        CodeReviewReviewersUpdatedNumRemoved: {
          $type: "System.Int32",
          $value: 0,
        },
      },
      isDeleted: false,
    },
    {
      pullRequestThreadContext: null,
      id: 143,
      publishedDate: "2016-11-01T16:30:36.58Z",
      lastUpdatedDate: "2016-11-01T16:30:36.58Z",
      comments: [
        {
          id: 1,
          parentCommentId: 0,
          author: {
            id: "41113706-4320-4083-9150-925feb93fc22",
            displayName: "[DefaultCollection]\\Project Collection Service Accounts",
            url: "https://dev.azure.com/fabrikam/_apis/Identities/41113706-4320-4083-9150-925feb93fc22",
            imageUrl:
              "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=41113706-4320-4083-9150-925feb93fc22",
            isContainer: true,
          },
          content: "Normal Paulk voted 10",
          publishedDate: "2016-11-01T16:30:36.58Z",
          lastUpdatedDate: "2016-11-01T16:30:36.58Z",
          commentType: "system",
          usersLiked: [],
        },
      ],
      threadContext: null,
      properties: {
        CodeReviewThreadType: {
          $type: "System.String",
          $value: "VoteUpdate",
        },
        CodeReviewVotedByDisplayName: {
          $type: "System.String",
          $value: "Normal Paulk",
        },
        CodeReviewVotedByTfId: {
          $type: "System.String",
          $value: "d6245f20-2af8-44f4-9451-8107cb2767db",
        },
        CodeReviewVoteResult: {
          $type: "System.String",
          $value: "10",
        },
      },
      isDeleted: false,
    },
    {
      pullRequestThreadContext: null,
      id: 144,
      publishedDate: "2016-11-01T16:30:38.603Z",
      lastUpdatedDate: "2016-11-01T16:30:38.603Z",
      comments: [
        {
          id: 1,
          parentCommentId: 0,
          author: {
            id: "41113706-4320-4083-9150-925feb93fc22",
            displayName: "[DefaultCollection]\\Project Collection Service Accounts",
            url: "https://dev.azure.com/fabrikam/_apis/Identities/41113706-4320-4083-9150-925feb93fc22",
            imageUrl:
              "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=41113706-4320-4083-9150-925feb93fc22",
            isContainer: true,
          },
          content: "Normal Paulk removed Johnnie McLeod from the reviewers",
          publishedDate: "2016-11-01T16:30:38.603Z",
          lastUpdatedDate: "2016-11-01T16:30:38.603Z",
          commentType: "system",
          usersLiked: [],
        },
      ],
      threadContext: null,
      properties: {
        CodeReviewThreadType: {
          $type: "System.String",
          $value: "ReviewersUpdate",
        },
        CodeReviewReviewersUpdatedByDisplayname: {
          $type: "System.String",
          $value: "Normal Paulk",
        },
        CodeReviewReviewersUpdatedByTfId: {
          $type: "System.String",
          $value: "b335b0d4578f4944b94ca45216eb1a1a",
        },
        CodeReviewReviewersUpdatedNumAdded: {
          $type: "System.Int32",
          $value: 0,
        },
        CodeReviewReviewersUpdatedNumRemoved: {
          $type: "System.Int32",
          $value: 1,
        },
        CodeReviewReviewersUpdatedRemovedDisplayName: {
          $type: "System.String",
          $value: "Johnnie McLeod",
        },
        CodeReviewReviewersUpdatedRemovedTfId: {
          $type: "System.String",
          $value: "2428198325304a9caeb788d60d57acfd",
        },
      },
      isDeleted: false,
    },
    {
      pullRequestThreadContext: null,
      id: 145,
      publishedDate: "2016-11-01T16:30:40.84Z",
      lastUpdatedDate: "2016-11-01T16:30:40.84Z",
      comments: [
        {
          id: 1,
          parentCommentId: 0,
          author: {
            id: "41113706-4320-4083-9150-925feb93fc22",
            displayName: "[DefaultCollection]\\Project Collection Service Accounts",
            url: "https://dev.azure.com/fabrikam/_apis/Identities/41113706-4320-4083-9150-925feb93fc22",
            imageUrl:
              "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=41113706-4320-4083-9150-925feb93fc22",
            isContainer: true,
          },
          content: "The reference refs/heads/npaulk/my_work was updated.",
          publishedDate: "2016-11-01T16:30:40.84Z",
          lastUpdatedDate: "2016-11-01T16:30:40.84Z",
          commentType: "system",
          usersLiked: [],
        },
      ],
      threadContext: null,
      properties: {
        CodeReviewThreadType: {
          $type: "System.String",
          $value: "RefUpdate",
        },
        CodeReviewRefName: {
          $type: "System.String",
          $value: "refs/heads/npaulk/my_work",
        },
        CodeReviewRefNewCommits: {
          $type: "System.String",
          $value: "8c9396b5cf22f929767c7172e9dbbe777ddc6357",
        },
        CodeReviewRefNewCommitsCount: {
          $type: "System.Int32",
          $value: 1,
        },
        CodeReviewRefNewHeadCommit: {
          $type: "System.String",
          $value: "8c9396b5cf22f929767c7172e9dbbe777ddc6357",
        },
        CodeReviewRefUpdatedBy: {
          $type: "System.String",
          $value: "fabrikamfiber16@hotmail.com",
        },
        CodeReviewRefUpdatedByDisplayName: {
          $type: "System.String",
          $value: "Normal Paulk",
        },
        CodeReviewRefUpdatedByTfId: {
          $type: "System.String",
          $value: "d6245f20-2af8-44f4-9451-8107cb2767db",
        },
      },
      isDeleted: false,
    },
    {
      pullRequestThreadContext: null,
      id: 146,
      publishedDate: "2016-11-01T16:30:41.123Z",
      lastUpdatedDate: "2016-11-01T16:30:41.123Z",
      comments: [
        {
          id: 1,
          parentCommentId: 0,
          author: {
            id: "41113706-4320-4083-9150-925feb93fc22",
            displayName: "[DefaultCollection]\\Project Collection Service Accounts",
            url: "https://dev.azure.com/fabrikam/_apis/Identities/41113706-4320-4083-9150-925feb93fc22",
            imageUrl:
              "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=41113706-4320-4083-9150-925feb93fc22",
            isContainer: true,
          },
          content:
            "The pull request is mergable and the target commit would be fd8da3e51efe350811d2157b2223df53d4db46c3.",
          publishedDate: "2016-11-01T16:30:41.123Z",
          lastUpdatedDate: "2016-11-01T16:30:41.123Z",
          commentType: "system",
          usersLiked: [],
        },
      ],
      threadContext: null,
      properties: {
        CodeReviewMergeCommit: {
          $type: "System.String",
          $value: "fd8da3e51efe350811d2157b2223df53d4db46c3",
        },
        CodeReviewMergeStatus: {
          $type: "System.String",
          $value: "Succeeded",
        },
        CodeReviewSourceCommit: {
          $type: "System.String",
          $value: "8c9396b5cf22f929767c7172e9dbbe777ddc6357",
        },
        CodeReviewTargetCommit: {
          $type: "System.String",
          $value: "f47bbc106853afe3c1b07a81754bce5f4b8dbf62",
        },
        CodeReviewThreadType: {
          $type: "System.String",
          $value: "MergeAttempt",
        },
      },
      isDeleted: false,
    },
    {
      pullRequestThreadContext: null,
      id: 147,
      publishedDate: "2016-11-01T16:30:48.91Z",
      lastUpdatedDate: "2016-11-01T16:30:48.91Z",
      comments: [
        {
          id: 1,
          parentCommentId: 0,
          author: {
            id: "d6245f20-2af8-44f4-9451-8107cb2767db",
            displayName: "Normal Paulk",
            uniqueName: "fabrikamfiber16@hotmail.com",
            url: "https://dev.azure.com/fabrikam/_apis/Identities/d6245f20-2af8-44f4-9451-8107cb2767db",
            imageUrl:
              "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=d6245f20-2af8-44f4-9451-8107cb2767db",
          },
          content: "This new feature looks good!",
          publishedDate: "2016-11-01T16:30:48.91Z",
          lastUpdatedDate: "2016-11-01T16:30:48.91Z",
          commentType: "text",
          usersLiked: [],
        },
      ],
      status: "active",
      threadContext: null,
      properties: {
        "Microsoft.TeamFoundation.Discussion.SupportsMarkdown": {
          $type: "System.Int32",
          $value: 1,
        },
      },
      isDeleted: false,
    },
    {
      pullRequestThreadContext: {
        iterationContext: {
          firstComparingIteration: 1,
          secondComparingIteration: 2,
        },
        changeTrackingId: 1,
      },
      id: 148,
      publishedDate: "2016-11-01T16:30:50.083Z",
      lastUpdatedDate: "2016-11-01T16:30:52.48Z",
      comments: [
        {
          id: 1,
          parentCommentId: 0,
          author: {
            id: "d6245f20-2af8-44f4-9451-8107cb2767db",
            displayName: "Normal Paulk",
            uniqueName: "fabrikamfiber16@hotmail.com",
            url: "https://dev.azure.com/fabrikam/_apis/Identities/d6245f20-2af8-44f4-9451-8107cb2767db",
            imageUrl:
              "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=d6245f20-2af8-44f4-9451-8107cb2767db",
          },
          content: "Should we add a comment about what this value means?",
          publishedDate: "2016-11-01T16:30:50.083Z",
          lastUpdatedDate: "2016-11-01T16:30:50.083Z",
          commentType: "text",
          usersLiked: [],
        },
        {
          id: 2,
          parentCommentId: 1,
          author: {
            id: "d6245f20-2af8-44f4-9451-8107cb2767db",
            displayName: "Normal Paulk",
            uniqueName: "fabrikamfiber16@hotmail.com",
            url: "https://dev.azure.com/fabrikam/_apis/Identities/d6245f20-2af8-44f4-9451-8107cb2767db",
            imageUrl:
              "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=d6245f20-2af8-44f4-9451-8107cb2767db",
          },
          publishedDate: "2016-11-01T16:30:51.383Z",
          lastUpdatedDate: "2016-11-01T16:30:52.48Z",
          isDeleted: true,
          commentType: "text",
          usersLiked: [],
        },
      ],
      status: "active",
      threadContext: {
        filePath: "/new_feature.cpp",
        rightFileStart: {
          line: 5,
          offset: 1,
        },
        rightFileEnd: {
          line: 5,
          offset: 13,
        },
      },
      properties: {
        "Microsoft.TeamFoundation.Discussion.SupportsMarkdown": {
          $type: "System.Int32",
          $value: 1,
        },
      },
      isDeleted: false,
    },
  ],
  count: 8,
} as const;

/** Pull Request Threads - Create sample response (general comment).
 * https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-threads/create?view=azure-devops-rest-7.1 */
export const AZURE_THREAD_CREATED = {
  pullRequestThreadContext: null,
  id: 147,
  publishedDate: "2016-11-01T16:30:48.91Z",
  lastUpdatedDate: "2016-11-01T16:30:48.91Z",
  comments: [
    {
      id: 1,
      parentCommentId: 0,
      author: {
        id: "d6245f20-2af8-44f4-9451-8107cb2767db",
        displayName: "Normal Paulk",
        uniqueName: "fabrikamfiber16@hotmail.com",
        url: "https://dev.azure.com/fabrikam/_apis/Identities/d6245f20-2af8-44f4-9451-8107cb2767db",
        imageUrl:
          "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=d6245f20-2af8-44f4-9451-8107cb2767db",
      },
      content: "This new feature looks good!",
      publishedDate: "2016-11-01T16:30:48.91Z",
      lastUpdatedDate: "2016-11-01T16:30:48.91Z",
      commentType: "text",
    },
  ],
  status: "active",
  threadContext: null,
  properties: {},
  isDeleted: false,
  _links: {
    self: {
      href: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/pullRequests/22/threads/147",
    },
    repository: {
      href: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719",
    },
  },
} as const;

/** Pull Request Threads - Create sample response (comment on /new_feature.cpp line 5). */
export const AZURE_FILE_THREAD_CREATED = {
  pullRequestThreadContext: {
    iterationContext: {
      firstComparingIteration: 1,
      secondComparingIteration: 2,
    },
    changeTrackingId: 1,
  },
  id: 148,
  publishedDate: "2016-11-01T16:30:50.083Z",
  lastUpdatedDate: "2016-11-01T16:30:50.083Z",
  comments: [
    {
      id: 1,
      parentCommentId: 0,
      author: {
        id: "d6245f20-2af8-44f4-9451-8107cb2767db",
        displayName: "Normal Paulk",
        uniqueName: "fabrikamfiber16@hotmail.com",
        url: "https://dev.azure.com/fabrikam/_apis/Identities/d6245f20-2af8-44f4-9451-8107cb2767db",
        imageUrl:
          "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=d6245f20-2af8-44f4-9451-8107cb2767db",
      },
      content: "Should we add a comment about what this value means?",
      publishedDate: "2016-11-01T16:30:50.083Z",
      lastUpdatedDate: "2016-11-01T16:30:50.083Z",
      commentType: "text",
    },
  ],
  status: "active",
  threadContext: {
    filePath: "/new_feature.cpp",
    rightFileStart: {
      line: 5,
      offset: 1,
    },
    rightFileEnd: {
      line: 5,
      offset: 13,
    },
  },
  properties: {},
  isDeleted: false,
  _links: {
    self: {
      href: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/pullRequests/22/threads/148",
    },
    repository: {
      href: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719",
    },
  },
} as const;

/** Pull Request Thread Comments - Create sample response (reply to thread 148).
 * https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-thread-comments/create?view=azure-devops-rest-7.1 */
export const AZURE_COMMENT_CREATED = {
  id: 2,
  parentCommentId: 1,
  author: {
    id: "d6245f20-2af8-44f4-9451-8107cb2767db",
    displayName: "Normal Paulk",
    uniqueName: "fabrikamfiber16@hotmail.com",
    url: "https://dev.azure.com/fabrikam/_apis/Identities/d6245f20-2af8-44f4-9451-8107cb2767db",
    imageUrl:
      "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=d6245f20-2af8-44f4-9451-8107cb2767db",
  },
  content: "Good idea",
  publishedDate: "2016-11-01T16:30:51.383Z",
  lastUpdatedDate: "2016-11-01T16:30:51.383Z",
  commentType: "text",
} as const;

/** Pull Request Iteration Changes - Get sample response (iteration 2).
 * https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-iteration-changes/get?view=azure-devops-rest-7.1 */
export const AZURE_ITERATION_CHANGES_22 = {
  changeEntries: [
    {
      changeTrackingId: 1,
      changeId: 1,
      item: {
        objectId: "e21e56d119ae81fb4ffebc4fefc6351f5b5ef888",
        path: "/new_feature.cpp",
      },
      changeType: "add",
    },
    {
      changeTrackingId: 2,
      changeId: 2,
      item: {
        objectId: "5ec0f71ffb8b47bd4c0117f624647963e021f3d2",
        path: "/new_feature.h",
      },
      changeType: "add",
    },
  ],
} as const;

/** Refs - Update Refs sample response.
 * https://learn.microsoft.com/en-us/rest/api/azure/devops/git/refs/update-refs?view=azure-devops-rest-7.1 */
export const AZURE_REF_UPDATE_RESULT = {
  value: [
    {
      repositoryId: "d3d1760b-311c-4175-a726-20dfc6a7f885",
      name: "refs/heads/vsts-api-sample/answer-woman-flame",
      oldObjectId: "0000000000000000000000000000000000000000",
      newObjectId: "ffe9cba521f00d7f60e322845072238635edb451",
      isLocked: false,
      updateStatus: "succeeded",
      success: true,
    },
  ],
  count: 1,
} as const;

/** Teams - Get Team Members With Extended Properties sample response `value` (what `az devops team list-member` prints).
 * https://learn.microsoft.com/en-us/rest/api/azure/devops/core/teams/get-team-members-with-extended-properties?view=azure-devops-rest-7.1 */
export const AZURE_TEAM_MEMBERS = [
  {
    isTeamAdmin: false,
    identity: {
      id: "3b5f0c34-4aec-4bf4-8708-1d36f0dbc468",
      displayName: "Christie Church",
      uniqueName: "fabrikamfiber1@hotmail.com",
      url: "https://vssps.dev.azure.com/fabrikam/_apis/Identities/3b5f0c34-4aec-4bf4-8708-1d36f0dbc468",
      imageUrl:
        "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=3b5f0c34-4aec-4bf4-8708-1d36f0dbc468",
    },
  },
  {
    isTeamAdmin: false,
    identity: {
      id: "8c8c7d32-6b1b-47f4-b2e9-30b477b5ab3d",
      displayName: "Chuck Reinhart",
      uniqueName: "fabrikamfiber3@hotmail.com",
      url: "https://vssps.dev.azure.com/fabrikam/_apis/Identities/8c8c7d32-6b1b-47f4-b2e9-30b477b5ab3d",
      imageUrl:
        "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=8c8c7d32-6b1b-47f4-b2e9-30b477b5ab3d",
    },
  },
  {
    isTeamAdmin: true,
    identity: {
      id: "19d9411e-9a34-45bb-b985-d24d9d87c0c9",
      displayName: "Johnnie McLeod",
      uniqueName: "fabrikamfiber2@hotmail.com",
      url: "https://vssps.dev.azure.com/fabrikam/_apis/Identities/19d9411e-9a34-45bb-b985-d24d9d87c0c9",
      imageUrl:
        "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=19d9411e-9a34-45bb-b985-d24d9d87c0c9",
    },
  },
] as const;

/** Tags - Get Tags sample response.
 * https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/tags/get-tags?view=azure-devops-rest-7.1 */
export const AZURE_TAGS = {
  count: 2,
  value: [
    {
      id: "18090594-b371-4140-99d2-fc93bcbcddec",
      name: "my-first-tag",
      url: "http://dev.azure.com/fabrikam/Fabrikam-Fiber-Git/_apis/wit/tags/18090594-b371-4140-99d2-fc93bcbcddec?api-version=5.1-preview",
      lastUpdated: "2022-11-01T10:56:26.433Z",
    },
    {
      id: "e4c198b9-171d-4e99-b163-4e17e659c0a2",
      name: "my-second-tag",
      url: "http://dev.azure.com/fabrikam/Fabrikam-Fiber-Git/_apis/wit/tags/e4c198b9-171d-4e99-b163-4e17e659c0a2?api-version=5.1-preview",
      lastUpdated: "2022-11-01T10:56:26.433Z",
    },
  ],
} as const;

/** Permissions - Has Permissions sample response (three tokens).
 * https://learn.microsoft.com/en-us/rest/api/azure/devops/security/permissions/has-permissions?view=azure-devops-rest-7.1 */
export const AZURE_PERMISSIONS_SAMPLE = {
  count: 3,
  value: [false, false, true],
} as const;

/** Configurations - List sample entry ("Build").
 * https://learn.microsoft.com/en-us/rest/api/azure/devops/policy/configurations/list?view=azure-devops-rest-7.1 */
export const AZURE_POLICY_CONFIGURATION_BUILD = {
  createdBy: {
    id: "d6245f20-2af8-44f4-9451-8107cb2767db",
    displayName: "Normal Paulk",
    uniqueName: "fabrikamfiber16@hotmail.com",
    url: "https://vssps.dev.azure.com/fabrikam/_apis/Identities/d6245f20-2af8-44f4-9451-8107cb2767db",
    imageUrl:
      "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=d6245f20-2af8-44f4-9451-8107cb2767db",
  },
  createdDate: "2015-02-23T12:51:06.935666Z",
  isEnabled: true,
  isBlocking: false,
  settings: {
    buildDefinitionId: 5,
    scope: [
      {
        refName: "refs/heads/features/",
        matchKind: "Prefix",
        repositoryId: null,
      },
    ],
  },
  _links: {
    self: {
      href: "https://dev.azure.com/fabrikam/_apis/policy/configurations/19",
    },
    type: {
      href: "https://dev.azure.com/fabrikam/1be3fc5b-c58c-4173-8fd7-6647d11eccd1/_apis/policy/types/0609b952-1397-4640-95ec-e00a01b2c241",
    },
  },
  revision: 1,
  id: 19,
  url: "https://dev.azure.com/fabrikam/_apis/policy/configurations/19",
  type: {
    id: "0609b952-1397-4640-95ec-e00a01b2c241",
    url: "https://dev.azure.com/fabrikam/1be3fc5b-c58c-4173-8fd7-6647d11eccd1/_apis/policy/types/0609b952-1397-4640-95ec-e00a01b2c241",
    displayName: "Build",
  },
} as const;

/** Configurations - List sample entry ("Minimum approval count"). */
export const AZURE_POLICY_CONFIGURATION_MINIMUM_APPROVALS = {
  createdBy: {
    id: "d6245f20-2af8-44f4-9451-8107cb2767db",
    displayName: "Normal Paulk",
    uniqueName: "fabrikamfiber16@hotmail.com",
    url: "https://vssps.dev.azure.com/fabrikam/_apis/Identities/d6245f20-2af8-44f4-9451-8107cb2767db",
    imageUrl:
      "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=d6245f20-2af8-44f4-9451-8107cb2767db",
  },
  createdDate: "2015-02-23T12:51:06.8887894Z",
  isEnabled: true,
  isBlocking: false,
  settings: {
    minimumApproverCount: 1,
    creatorVoteCounts: false,
    scope: [
      {
        refName: "refs/heads/master",
        matchKind: "Exact",
        repositoryId: null,
      },
    ],
  },
  _links: {
    self: {
      href: "https://dev.azure.com/fabrikam/_apis/policy/configurations/18",
    },
    type: {
      href: "https://dev.azure.com/fabrikam/1be3fc5b-c58c-4173-8fd7-6647d11eccd1/_apis/policy/types/fa4e907d-c16b-4a4c-9dfa-4906e5d171dd",
    },
  },
  revision: 1,
  id: 18,
  url: "https://dev.azure.com/fabrikam/_apis/policy/configurations/18",
  type: {
    id: "fa4e907d-c16b-4a4c-9dfa-4906e5d171dd",
    url: "https://dev.azure.com/fabrikam/1be3fc5b-c58c-4173-8fd7-6647d11eccd1/_apis/policy/types/fa4e907d-c16b-4a4c-9dfa-4906e5d171dd",
    displayName: "Minimum approval count",
  },
} as const;

/** Configurations - Create sample response ("Require a merge strategy", squash only).
 * https://learn.microsoft.com/en-us/rest/api/azure/devops/policy/configurations/create?view=azure-devops-rest-7.1 */
export const AZURE_POLICY_CONFIGURATION_MERGE_STRATEGY = {
  createdBy: {
    id: "d6245f20-2af8-44f4-9451-8107cb2767db",
    displayName: "Normal Paulk",
    uniqueName: "fabrikamfiber16@hotmail.com",
    url: "https://vssps.dev.azure.com/fabrikam/_apis/Identities/d6245f20-2af8-44f4-9451-8107cb2767db",
    imageUrl:
      "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=d6245f20-2af8-44f4-9451-8107cb2767db",
  },
  createdDate: "2015-02-23T12:51:06.935666",
  isEnabled: true,
  isBlocking: true,
  settings: {
    useSquashMerge: true,
    scope: [
      {
        refName: "refs/heads/master",
        matchKind: "Exact",
        repositoryId: "1d1dad71-f27c-4370-810d-838ec41efd41",
      },
    ],
  },
  _links: {
    self: {
      href: "https://dev.azure.com/fabrikam/_apis/policy/configurations/19",
    },
    type: {
      href: "https://dev.azure.com/fabrikam/1be3fc5b-c58c-4173-8fd7-6647d11eccd1/_apis/policy/types/fa4e907d-c16b-4a4c-9dfa-4916e5d171ab",
    },
  },
  revision: 1,
  id: 19,
  url: "https://dev.azure.com/fabrikam/_apis/policy/configurations/19",
  type: {
    id: "fa4e907d-c16b-4a4c-9dfa-4916e5d171ab",
    url: "https://dev.azure.com/fabrikam/1be3fc5b-c58c-4173-8fd7-6647d11eccd1/_apis/policy/types/fa4e907d-c16b-4a4c-9dfa-4916e5d171ab",
    displayName: "Require a merge strategy",
  },
} as const;

/**
 * Pull Request Iterations - List for PR 22. The reference page has no sample,
 * so this is built from the documented `GitPullRequestIteration` fields, with
 * the commits of the official thread sample (MergeAttempt / RefUpdate threads).
 * https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-iterations/list?view=azure-devops-rest-7.1
 */
export const AZURE_ITERATIONS_22 = {
  value: [
    {
      id: 1,
      description: "Adding a new feature",
      author: {
        id: "d6245f20-2af8-44f4-9451-8107cb2767db",
        displayName: "Normal Paulk",
        uniqueName: "fabrikamfiber16@hotmail.com",
      },
      createdDate: "2016-11-01T16:30:31.703Z",
      updatedDate: "2016-11-01T16:30:31.703Z",
      sourceRefCommit: { commitId: "b60280bc6e62e2f880f1b63c1e24987664d3bda3" },
      targetRefCommit: { commitId: "f47bbc106853afe3c1b07a81754bce5f4b8dbf62" },
      commonRefCommit: { commitId: "f47bbc106853afe3c1b07a81754bce5f4b8dbf62" },
      hasMoreCommits: false,
      reason: "create",
    },
    {
      id: 2,
      description: "Adding a new feature",
      author: {
        id: "d6245f20-2af8-44f4-9451-8107cb2767db",
        displayName: "Normal Paulk",
        uniqueName: "fabrikamfiber16@hotmail.com",
      },
      createdDate: "2016-11-01T16:30:40.84Z",
      updatedDate: "2016-11-01T16:30:40.84Z",
      sourceRefCommit: { commitId: "8c9396b5cf22f929767c7172e9dbbe777ddc6357" },
      targetRefCommit: { commitId: "f47bbc106853afe3c1b07a81754bce5f4b8dbf62" },
      commonRefCommit: { commitId: "f47bbc106853afe3c1b07a81754bce5f4b8dbf62" },
      hasMoreCommits: false,
      reason: "forcePush",
      push: {
        pushId: 2,
        date: "2016-11-01T16:30:40.84Z",
        pushedBy: {
          id: "d6245f20-2af8-44f4-9451-8107cb2767db",
          displayName: "Normal Paulk",
          uniqueName: "fabrikamfiber16@hotmail.com",
        },
      },
    },
  ],
  count: 2,
} as const;

/**
 * Pull Request Commits - Get Pull Request Commits for PR 22 (newest first).
 * Built from the documented `GitCommitRef` fields (no sample on the page).
 * https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-commits/get-pull-request-commits?view=azure-devops-rest-7.1
 */
export const AZURE_COMMITS_22 = {
  value: [
    {
      commitId: "8c9396b5cf22f929767c7172e9dbbe777ddc6357",
      author: {
        name: "Normal Paulk",
        email: "fabrikamfiber16@hotmail.com",
        date: "2016-11-01T16:30:38Z",
      },
      committer: {
        name: "Normal Paulk",
        email: "fabrikamfiber16@hotmail.com",
        date: "2016-11-01T16:30:38Z",
      },
      comment: "Document the new value\n\nExplains what the value means.",
      url: "https://dev.azure.com/fabrikam/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/commits/8c9396b5cf22f929767c7172e9dbbe777ddc6357",
    },
  ],
  count: 1,
  continuation_token: null,
} as const;

/**
 * `az repos pr policy list` output (Evaluations - List). The reference has no
 * sample, so each record is built from the documented `PolicyEvaluationRecord`
 * fields around the official policy configuration examples above.
 * https://learn.microsoft.com/en-us/rest/api/azure/devops/policy/evaluations/list?view=azure-devops-rest-7.1
 */
export function azurePolicyEvaluations(input: {
  readonly build: "queued" | "running" | "approved" | "rejected";
  readonly minimumApprovals: "queued" | "running" | "approved" | "rejected";
  readonly mergeStrategy?: boolean;
}) {
  const record = (configuration: unknown, status: string, evaluationId: string) => ({
    artifactId: "vstfs:///CodeReview/CodeReviewId/a7573007-bbb3-4341-b726-0c4148a07853/22",
    evaluationId,
    startedDate: "2016-11-01T16:30:41.123Z",
    completedDate: status === "queued" || status === "running" ? null : "2016-11-01T16:35:00Z",
    status,
    configuration,
  });
  return [
    record(
      { ...AZURE_POLICY_CONFIGURATION_BUILD, isBlocking: true },
      input.build,
      "a1d1e0b0-0000-4000-8000-000000000001",
    ),
    record(
      { ...AZURE_POLICY_CONFIGURATION_MINIMUM_APPROVALS, isBlocking: true },
      input.minimumApprovals,
      "a1d1e0b0-0000-4000-8000-000000000002",
    ),
    ...(input.mergeStrategy
      ? [
          record(
            AZURE_POLICY_CONFIGURATION_MERGE_STRATEGY,
            "approved",
            "a1d1e0b0-0000-4000-8000-000000000003",
          ),
        ]
      : []),
  ];
}

/**
 * `GET _apis/connectionData` (`ConnectionData`, Location API; not on the
 * REST reference, shape from the published client models).
 */
export const AZURE_CONNECTION_DATA = {
  authenticatedUser: {
    id: "d6245f20-2af8-44f4-9451-8107cb2767db",
    descriptor: "Microsoft.IdentityModel.Claims.ClaimsIdentity;fabrikamfiber16@hotmail.com",
    subjectDescriptor: "msa.ZDYyNDVmMjAtMmFmOC03NDRmLTk0NTEtODEwN2NiMjc2N2Ri",
    providerDisplayName: "Normal Paulk",
    isActive: true,
    properties: {
      Account: { $type: "System.String", $value: "fabrikamfiber16@hotmail.com" },
    },
    resourceVersion: 2,
    metaTypeId: 0,
  },
  instanceId: "6e3b4d0a-0000-4000-8000-000000000000",
  deploymentId: "6e3b4d0a-0000-4000-8000-000000000001",
  deploymentType: "hosted",
  locationServiceData: { serviceOwner: "00025394-6065-48ca-87d9-7f5672854ef7" },
} as const;

/** Pull Request Threads - Create sample request body (general comment). */
export const AZURE_THREAD_CREATE_REQUEST = {
  comments: [
    {
      parentCommentId: 0,
      content: "This new feature looks good!",
      commentType: 1,
    },
  ],
  status: 1,
} as const;

/** Pull Request Threads - Create sample request body (line comment). */
export const AZURE_FILE_THREAD_CREATE_REQUEST = {
  comments: [
    {
      parentCommentId: 0,
      content: "Should we add a comment about what this value means?",
      commentType: 1,
    },
  ],
  status: 1,
  threadContext: {
    filePath: "/new_feature.cpp",
    leftFileEnd: null,
    leftFileStart: null,
    rightFileEnd: {
      line: 5,
      offset: 13,
    },
    rightFileStart: {
      line: 5,
      offset: 1,
    },
  },
  pullRequestThreadContext: {
    changeTrackingId: 1,
    iterationContext: {
      firstComparingIteration: 1,
      secondComparingIteration: 2,
    },
  },
} as const;

/** Pull Request Thread Comments - Create sample request body. */
export const AZURE_COMMENT_CREATE_REQUEST = {
  content: "Good idea",
  parentCommentId: 1,
  commentType: 1,
} as const;
