#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  approvalCountForHead,
  isCoreAuthor,
  leaderParticipated,
  requiredApprovalsForAuthor,
} from "./review-policy.mjs";

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

async function createCommitStatus({ sha, state, context, description, targetUrl }) {
  const response = await fetch(
    `https://api.github.com/repos/${policy.repository}/statuses/${sha}`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        state,
        context,
        description,
        target_url: targetUrl,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `REST commit status request failed: ${response.status} ${await response.text()}`,
    );
  }
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
let filesDone = false;
let reviewsDone = false;
let headSha = pullRequest.head.sha;
while (!filesDone || !reviewsDone) {
  const data = await graphql(
    `
      query (
        $owner: String!
        $name: String!
        $number: Int!
        $filesCursor: String
        $reviewsCursor: String
        $includeFiles: Boolean!
        $includeReviews: Boolean!
      ) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            headRefOid
            files(first: 100, after: $filesCursor) @include(if: $includeFiles) {
              nodes {
                path
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
            reviews(first: 100, after: $reviewsCursor) @include(if: $includeReviews) {
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
      filesCursor: filesDone ? null : filesCursor,
      reviewsCursor: reviewsDone ? null : reviewsCursor,
      includeFiles: !filesDone,
      includeReviews: !reviewsDone,
    },
  );
  headSha = data.repository.pullRequest.headRefOid;
  if (!filesDone) {
    const filesConnection = data.repository.pullRequest.files;
    files.push(...(filesConnection?.nodes || []));
    const filesPage = filesConnection?.pageInfo;
    filesDone = !filesPage?.hasNextPage;
    filesCursor = filesDone ? null : filesPage.endCursor;
  }
  if (!reviewsDone) {
    const reviewsConnection = data.repository.pullRequest.reviews;
    reviews.push(...(reviewsConnection?.nodes || []));
    const reviewsPage = reviewsConnection?.pageInfo;
    reviewsDone = !reviewsPage?.hasNextPage;
    reviewsCursor = reviewsDone ? null : reviewsPage.endCursor;
  }
}
const highRisk = files.some((file) =>
  policy.highRiskPaths.some((pattern) => globToRegExp(pattern).test(file.path)),
);
const authorAssociation = pullRequest.author_association || "NONE";
const coreAuthor = isCoreAuthor(pullRequest.user.login, policy, authorAssociation);
const requiredApprovals = requiredApprovalsForAuthor(
  pullRequest.user.login,
  policy,
  authorAssociation,
);
const approvalCount = approvalCountForHead({
  reviews,
  headSha,
  authorLogin: pullRequest.user.login,
  policy,
});
const approvalsSatisfied = approvalCount >= requiredApprovals;
const leaderParticipatedForHead = leaderParticipated({
  authorLogin: pullRequest.user.login,
  reviews,
  headSha,
  policy,
});
const state =
  approvalsSatisfied && (!highRisk || leaderParticipatedForHead) ? "success" : "failure";
const authorDescription =
  pullRequest.user.login === policy.leader
    ? policy.leader
    : coreAuthor
      ? "非 Leader Core 作者"
      : "社区作者";
const approvalDescription =
  `${authorDescription}：${approvalCount}/${requiredApprovals} 个当前 head 有效的非作者审批`;
const leaderDescription = !highRisk
  ? "普通改动：Leader 参与检查不适用"
  : leaderParticipatedForHead
    ? `高风险改动：${policy.leader} 已作为作者或最新提交批准者参与`
    : `高风险改动必须由 ${policy.leader} 作为作者或最新提交批准者参与`;
const description = approvalsSatisfied
  ? `${approvalDescription}；${leaderDescription}`
  : `${approvalDescription}；审批数不足`;

const workflowUrl = process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : `https://github.com/${policy.repository}/pull/${pullRequestNumber}`;

await createCommitStatus({
  sha: headSha,
  state,
  context: "governance-review",
  description: description.slice(0, 140),
  targetUrl: workflowUrl,
});

if (state !== "success") process.exit(1);
console.log(`[governance-review] ${description}`);
