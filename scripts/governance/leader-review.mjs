#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const policy = JSON.parse(readFileSync(join(root, ".governance/github-policy.json"), "utf8"));
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
const pullRequest = event.pull_request;
if (!pullRequest || !process.env.GITHUB_TOKEN || !process.env.GITHUB_REPOSITORY) {
  console.log("[governance-review] no pull request event; nothing to evaluate");
  process.exit(0);
}

const graphqlEndpoint = "https://api.github.com/graphql";
const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
  "X-GitHub-Api-Version": "2022-11-28",
};

async function graphql(query, variables) {
  const response = await fetch(graphqlEndpoint, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    throw new Error(`GraphQL request failed: ${response.status} ${await response.text()}`);
  }
  const payload = await response.json();
  if (payload.errors?.length)
    throw new Error(payload.errors.map((item) => item.message).join("; "));
  return payload.data;
}

function globToRegExp(pattern) {
  let expression = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (char === "*") expression += "[^/]*";
    else expression += char.replace(/[\\^$+?.()|{}\[\]]/g, "\\$&");
  }
  return new RegExp(`^${expression}$`);
}

const pullRequestNumber = Number(pullRequest.number);
if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) {
  throw new Error("Pull request number is invalid");
}
const [owner, repositoryName] = policy.repository.split("/", 2);
let files = [];
let reviews = [];
let filesCursor = null;
let reviewsCursor = null;
let repositoryId;
let headSha = pullRequest.head.sha;
for (;;) {
  const data = await graphql(
    `
      query (
        $owner: String!
        $name: String!
        $number: Int!
        $filesCursor: String
        $reviewsCursor: String
      ) {
        repository(owner: $owner, name: $name) {
          id
          pullRequest(number: $number) {
            headRefOid
            files(first: 100, after: $filesCursor) {
              nodes {
                path
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
            reviews(first: 100, after: $reviewsCursor) {
              nodes {
                author {
                  login
                }
                state
                commit {
                  oid
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      }
    `,
    {
      owner,
      name: repositoryName,
      number: pullRequestNumber,
      filesCursor,
      reviewsCursor,
    },
  );
  repositoryId = data.repository.id;
  headSha = data.repository.pullRequest.headRefOid;
  files.push(...(data.repository.pullRequest.files.nodes || []));
  reviews.push(...(data.repository.pullRequest.reviews.nodes || []));
  const filesPage = data.repository.pullRequest.files.pageInfo;
  const reviewsPage = data.repository.pullRequest.reviews.pageInfo;
  filesCursor = filesPage.hasNextPage ? filesPage.endCursor : null;
  reviewsCursor = reviewsPage.hasNextPage ? reviewsPage.endCursor : null;
  if (!filesCursor && !reviewsCursor) break;
}
const highRisk = files.some((file) =>
  policy.highRiskPaths.some((pattern) => globToRegExp(pattern).test(file.path)),
);
const leaderParticipated =
  pullRequest.user.login === policy.leader ||
  reviews.some(
    (review) =>
      review.author?.login === policy.leader &&
      review.state === "APPROVED" &&
      review.commit?.oid === headSha,
  );
const state = !highRisk || leaderParticipated ? "success" : "failure";
const description = !highRisk
  ? "普通改动：Leader 参与检查不适用"
  : leaderParticipated
    ? `高风险改动：${policy.leader} 已作为作者或最新提交批准者参与`
    : `高风险改动必须由 ${policy.leader} 作为作者或最新提交批准者参与`;

const workflowUrl = process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : `https://github.com/${policy.repository}/pull/${pullRequestNumber}`;

await graphql(
  `
    mutation (
      $repositoryId: ID!
      $sha: GitObjectID!
      $state: CommitState!
      $context: String!
      $description: String!
      $targetUrl: URI
    ) {
      createCommitStatus(
        input: {
          repositoryId: $repositoryId
          sha: $sha
          state: $state
          context: $context
          description: $description
          targetUrl: $targetUrl
        }
      ) {
        context
      }
    }
  `,
  {
    repositoryId,
    sha: headSha,
    state: state.toUpperCase(),
    context: "governance-review",
    description: description.slice(0, 140),
    targetUrl: workflowUrl,
  },
);

if (state !== "success") process.exit(1);
console.log(`[governance-review] ${description}`);
