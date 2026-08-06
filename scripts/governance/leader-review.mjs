#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  approvalCountForHead,
  classifyDependabotFiles,
  dependabotApprovalForHead,
  isCoreAuthor,
  isDependabotAuthor,
  leaderParticipated,
  leaderReviewMode,
  leaderSelfReviewForHead,
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

// Keep all REST URL components sourced from GitHub's runner environment rather
// than from JSON files. The event and policy files are trusted metadata for the
// review calculation, but CodeQL must not model their contents as an arbitrary
// outbound URL. Fail closed if the runner identity and checked-in policy do not
// describe this repository/PR exactly.
const repository = process.env.GITHUB_REPOSITORY;
if (repository !== policy.repository) {
  throw new Error(`runner repository ${repository} does not match governance policy`);
}
const pullRequestRef = /^refs\/pull\/([1-9][0-9]*)\/merge$/.exec(process.env.GITHUB_REF || "");
if (!pullRequestRef) throw new Error("GITHUB_REF is not a pull request merge ref");
const pullRequestNumber = Number(pullRequestRef[1]);
if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) {
  throw new Error("pull request ref number is invalid");
}
if (Number(pullRequest.number) !== pullRequestNumber) {
  throw new Error("event pull request number does not match GITHUB_REF");
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

async function restJson(path) {
  const response = await fetch(`https://api.github.com${path}`, { headers });
  if (!response.ok) {
    throw new Error(`REST request failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function listPullRequestFiles(repository, pullRequestNumber) {
  const files = [];
  for (let page = 1; ; page += 1) {
    const pageFiles = await restJson(
      `/repos/${repository}/pulls/${pullRequestNumber}/files?per_page=100&page=${page}`,
    );
    if (!Array.isArray(pageFiles)) throw new Error("REST pull request files response is invalid");
    files.push(...pageFiles);
    if (pageFiles.length < 100) return files;
  }
}

async function headCommitMetadata(repository, headSha) {
  const [owner, name] = repository.split("/", 2);
  const data = await graphql(
    `
      query ($owner: String!, $name: String!, $oid: GitObjectID!) {
        repository(owner: $owner, name: $name) {
          object(oid: $oid) {
            ... on Commit {
              author {
                user {
                  login
                }
              }
              committer {
                user {
                  login
                }
              }
            }
          }
        }
      }
    `,
    { owner, name, oid: headSha },
  );
  const commit = data.repository?.object;
  return {
    authorLogin: commit?.author?.user?.login || null,
    committerLogin: commit?.committer?.user?.login || null,
  };
}

async function createCommitStatus({ sha, state, context, description, targetUrl }) {
  const response = await fetch(`https://api.github.com/repos/${repository}/statuses/${sha}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      state,
      context,
      description,
      target_url: targetUrl,
    }),
  });
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

const [owner, repositoryName] = repository.split("/", 2);
let files = [];
let reviews = [];
let filesCursor = null;
let reviewsCursor = null;
let filesDone = false;
let reviewsDone = false;
let headSha = null;
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
if (!headSha) throw new Error("GitHub did not return a pull request head SHA");
// GraphQL exposes paths but not patches on PullRequestChangedFile. Read the
// same trusted PR metadata through REST so Dependabot workflow changes can be
// restricted to exact SHA-pinned action lines.
files = await listPullRequestFiles(repository, pullRequestNumber);
const dependabotAuthor = isDependabotAuthor(pullRequest.user.login, policy);
const dependabotScope = dependabotAuthor
  ? classifyDependabotFiles(files, policy)
  : { eligible: false, reason: "PR author is not Dependabot" };
let headCommit = null;
let headCommitError = null;
if (dependabotAuthor && dependabotScope.eligible) {
  try {
    headCommit = await headCommitMetadata(repository, headSha);
  } catch (error) {
    headCommitError = error instanceof Error ? error.message : String(error);
  }
}
const highRisk =
  !dependabotScope.eligible &&
  files.some((file) =>
    policy.highRiskPaths.some((pattern) => globToRegExp(pattern).test(file.path || file.filename)),
  );
const authorAssociation = pullRequest.author_association || "NONE";
const coreAuthor = isCoreAuthor(pullRequest.user.login, policy, authorAssociation);
const requiredApprovals = requiredApprovalsForAuthor(
  pullRequest.user.login,
  policy,
  authorAssociation,
);
const leaderMode = leaderReviewMode(policy);
const leaderSelfReview = leaderSelfReviewForHead(reviews, headSha, pullRequest.user.login, policy);
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
const dependabotApproval = dependabotScope.eligible
  ? dependabotApprovalForHead({ reviews, headSha, policy, headCommit })
  : null;
if (dependabotApproval && headCommitError) {
  dependabotApproval.satisfied = false;
  dependabotApproval.reason = `unable to verify head commit author/committer: ${headCommitError}`;
}
const state = dependabotScope.eligible
  ? dependabotApproval.satisfied && (!highRisk || leaderParticipatedForHead)
    ? "success"
    : "failure"
  : approvalsSatisfied && (!highRisk || leaderParticipatedForHead)
    ? "success"
    : "failure";
const authorDescription = dependabotScope.eligible
  ? "Dependabot 低风险自动化"
  : dependabotAuthor
    ? "Dependabot（普通/高风险规则）"
    : pullRequest.user.login === policy.leader
      ? policy.leader
      : coreAuthor
        ? "非 Leader Core 作者"
        : "社区作者";
const approvalDescription = dependabotScope.eligible
  ? `${authorDescription}：${dependabotApproval.leaderApproved ? "Leader 当前 head 已批准" : "缺少 Leader 当前 head 批准"}；${dependabotApproval.reason}`
  : pullRequest.user.login === policy.leader && leaderMode === "self-or-exempt"
    ? `${authorDescription}：Leader 作者规则免除额外治理审批（要求 ${requiredApprovals}）${leaderSelfReview ? "；检测到当前 head 的 Leader self-review（仅显示，不创建 Review）" : "；无 self-review 也通过"}`
    : `${authorDescription}：${approvalCount}/${requiredApprovals} 个当前 head 有效审批`;
const leaderDescription = !highRisk
  ? "普通改动：Leader 参与检查不适用"
  : leaderParticipatedForHead
    ? `高风险改动：${policy.leader} 已作为作者或最新提交批准者参与`
    : `高风险改动必须由 ${policy.leader} 作为作者或最新提交批准者参与`;
const description = dependabotScope.eligible
  ? `${approvalDescription}；current-head 约束由 governance-review 执行，签名提交和必需状态仍由 GitHub Ruleset 强制`
  : approvalsSatisfied
    ? `${approvalDescription}；${leaderDescription}`
    : `${approvalDescription}；审批数不足`;

const workflowUrl = process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : `https://github.com/${repository}/pull/${pullRequestNumber}`;

await createCommitStatus({
  sha: headSha,
  state,
  context: "governance-review",
  description: description.slice(0, 140),
  targetUrl: workflowUrl,
});

if (state !== "success") process.exit(1);
console.log(`[governance-review] ${description}`);
