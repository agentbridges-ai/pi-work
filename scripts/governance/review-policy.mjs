const coreAuthorAssociations = new Set(["COLLABORATOR", "MEMBER", "OWNER"]);
const leaderReviewModes = new Set(["required", "self-or-exempt"]);

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

export function pathMatches(patterns, path) {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}

export function isDependabotAuthor(authorLogin, policy) {
  const actors = policy.dependabotReview?.authorLogins ||
    policy.dependabotReview?.actorLogins || ["dependabot[bot]", "app/dependabot"];
  return typeof authorLogin === "string" && actors.includes(authorLogin);
}

export function coreReviewerLogins(policy) {
  const configured = policy.reviewEnforcement?.coreReviewerLogins;
  if (!Array.isArray(configured)) return new Set([policy.leader]);
  return new Set(configured.filter((login) => typeof login === "string" && login.length > 0));
}

export function isCountableReviewer(login, policy) {
  return typeof login === "string" && coreReviewerLogins(policy).has(login);
}

function changedPatchLines(patch) {
  if (typeof patch !== "string" || patch.length === 0) return null;
  return patch
    .split(/\r?\n/)
    .filter((line) => /^[+-]/.test(line) && !/^(?:---|\+\+\+)/.test(line))
    .map((line) => line.slice(1));
}

function patchMatches(patch, pattern) {
  const lines = changedPatchLines(patch);
  if (!lines || lines.length === 0) return false;
  const expression = new RegExp(pattern);
  return lines.every((line) => expression.test(line));
}

/**
 * Classify whether a Dependabot PR is the narrow, low-risk automation case.
 * The caller must still enforce native signature/required-check rules and the
 * trusted governance-review current-head policy; this function only classifies
 * changed paths/content.
 */
export function classifyDependabotFiles(files, policy) {
  const config = policy.dependabotReview;
  if (!config?.enabled) return { eligible: false, reason: "Dependabot review policy is disabled" };
  if (!Array.isArray(files) || files.length === 0) {
    return { eligible: false, reason: "no changed files were returned" };
  }

  let hasWorkflowActionPin = false;
  let hasSupportingFixture = false;
  for (const file of files) {
    const path = file?.path || file?.filename;
    if (typeof path !== "string") return { eligible: false, reason: "changed file has no path" };

    if (pathMatches(config.excludedWorkflowPaths || [], path)) {
      return {
        eligible: false,
        reason: `${path} is an excluded release/security/governance workflow`,
      };
    }
    if (Array.isArray(config.allowedPathGlobs) && !pathMatches(config.allowedPathGlobs, path)) {
      return { eligible: false, reason: `${path} is outside the Dependabot allowed path globs` };
    }
    const isWorkflowActionPin = pathMatches(config.workflowActionPinPaths || [], path);
    const isSupportingFixture = pathMatches(config.supportingFixturePaths || [], path);
    const isDependencyPath = pathMatches(config.dependencyPaths || [], path);

    // A supporting fixture is a single, exact SHA list update coupled to the
    // workflow action pin. It is not a general scripts/** exception.
    if (isSupportingFixture) {
      if (!patchMatches(file.patch, config.supportingFixturePattern)) {
        return {
          eligible: false,
          reason: `${path} is not an exact SHA fixture-only change`,
        };
      }
      hasSupportingFixture = true;
      continue;
    }

    if (isWorkflowActionPin) {
      if (
        config.workflowActionPinOnly !== true ||
        !patchMatches(file.patch, config.workflowActionPinPattern)
      ) {
        return {
          eligible: false,
          reason: `${path} is not a SHA-pinned workflow action-only change`,
        };
      }
      hasWorkflowActionPin = true;
      continue;
    }

    if (pathMatches(config.excludedPaths || [], path)) {
      return {
        eligible: false,
        reason: `${path} is in an excluded high-risk/product/security/release path`,
      };
    }
    if (!isDependencyPath) {
      return {
        eligible: false,
        reason: `${path} is outside dependency manifests, lockfiles, and action pins`,
      };
    }
  }

  if (hasSupportingFixture && !hasWorkflowActionPin) {
    return {
      eligible: false,
      reason: "the Dependabot SHA fixture must accompany a workflow action pin",
    };
  }
  return {
    eligible: true,
    reason: hasWorkflowActionPin
      ? "SHA-pinned workflow action update (with optional exact SHA fixture)"
      : "dependency manifest/lockfile update",
  };
}

export function leaderIsLastPusher(headCommit, policy) {
  const leader = policy.dependabotReview?.leader || policy.leader;
  const identities = [
    headCommit?.authorLogin,
    headCommit?.committerLogin,
    headCommit?.author?.login,
    headCommit?.committer?.login,
  ];
  return identities.includes(leader);
}

export function dependabotApprovalForHead({ reviews, headSha, policy, headCommit }) {
  const leader = policy.dependabotReview?.leader || policy.leader;
  const approvedReviewers = approvedReviewersForHead(reviews, headSha).filter((login) =>
    isCountableReviewer(login, policy),
  );
  const leaderApproved = approvedReviewers.includes(leader);
  const lastPusherIsLeader = leaderIsLastPusher(headCommit, policy);
  const satisfied =
    policy.dependabotReview?.requireCurrentHeadLeaderApproval === true &&
    leaderApproved &&
    !lastPusherIsLeader;
  let reason;
  if (!leaderApproved) reason = `Leader ${leader} has no current-head APPROVED review`;
  else if (lastPusherIsLeader) {
    reason = `Leader ${leader} is the latest commit author/committer; governance-review current-head approval cannot be self-counted`;
  } else reason = `Leader ${leader} has the required current-head APPROVED review`;
  return { satisfied, leaderApproved, lastPusherIsLeader, approvedReviewers, reason };
}

export function leaderReviewMode(policy) {
  const mode =
    policy.leaderReviewMode ?? (policy.leaderSelfApproval === true ? "self-or-exempt" : "required");
  if (!leaderReviewModes.has(mode)) throw new Error(`unsupported leaderReviewMode: ${mode}`);
  return mode;
}

export function isCoreAuthor(authorLogin, policy, authorAssociation = "MEMBER") {
  return authorLogin === policy.leader || coreAuthorAssociations.has(authorAssociation);
}

export function requiredApprovalsForAuthor(authorLogin, policy, authorAssociation = "MEMBER") {
  if (authorLogin === policy.leader) {
    return leaderReviewMode(policy) === "self-or-exempt" ? 0 : policy.leaderApprovals;
  }
  if (isCoreAuthor(authorLogin, policy, authorAssociation)) return policy.nonLeaderCoreApprovals;
  return policy.ordinaryApprovals;
}

export function approvedReviewersForHead(
  reviews,
  headSha,
  excludedAuthor = null,
  excludedReviewers = [],
) {
  const excludedLogins = new Set(
    [excludedAuthor, ...excludedReviewers].filter((login) => typeof login === "string"),
  );
  const latestReviews = new Map();
  for (const [index, review] of reviews.entries()) {
    const login = review.author?.login;
    if (review.commit?.oid !== headSha || typeof login !== "string") continue;
    const submittedAt = Date.parse(
      review.submittedAt || review.updatedAt || review.createdAt || "",
    );
    const previous = latestReviews.get(login);
    const previousAt = previous
      ? Date.parse(
          previous.review.submittedAt ||
            previous.review.updatedAt ||
            previous.review.createdAt ||
            "",
        )
      : NaN;
    if (
      !previous ||
      (Number.isFinite(submittedAt) &&
        (!Number.isFinite(previousAt) ||
          submittedAt > previousAt ||
          (submittedAt === previousAt && index > previous.index))) ||
      (!Number.isFinite(submittedAt) && !Number.isFinite(previousAt) && index > previous.index)
    ) {
      latestReviews.set(login, { index, review });
    }
  }
  return [
    ...new Set(
      [...latestReviews.values()]
        .map(({ review }) => review)
        .filter((review) => review.state === "APPROVED" && !excludedLogins.has(review.author.login))
        .map((review) => review.author.login),
    ),
  ];
}

export function countableReviewersForHead(
  reviews,
  headSha,
  policy,
  excludedAuthor = null,
  excludedReviewers = [],
) {
  return approvedReviewersForHead(reviews, headSha, excludedAuthor, excludedReviewers).filter(
    (login) => isCountableReviewer(login, policy),
  );
}

export function leaderSelfReviewForHead(reviews, headSha, authorLogin, policy) {
  return (
    leaderReviewMode(policy) === "self-or-exempt" &&
    authorLogin === policy.leader &&
    approvedReviewersForHead(reviews, headSha).includes(authorLogin)
  );
}

export function approvalCountForHead({
  reviews,
  headSha,
  authorLogin,
  policy,
  headCommit = null,
}) {
  const excludedPushers = [headCommit?.authorLogin, headCommit?.committerLogin];
  const approvedReviewers = countableReviewersForHead(
    reviews,
    headSha,
    policy,
    authorLogin,
    excludedPushers,
  );
  return (
    approvedReviewers.length +
    (leaderSelfReviewForHead(reviews, headSha, authorLogin, policy) ? 1 : 0)
  );
}

export function leaderParticipated({ authorLogin, reviews, headSha, policy, headCommit = null }) {
  const excludedPushers = [headCommit?.authorLogin, headCommit?.committerLogin];
  return (
    authorLogin === policy.leader ||
    approvedReviewersForHead(reviews, headSha, null, excludedPushers).includes(policy.leader)
  );
}
