const coreAuthorAssociations = new Set(["COLLABORATOR", "MEMBER", "OWNER"]);
const leaderReviewModes = new Set(["required", "self-or-exempt"]);

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

export function approvedReviewersForHead(reviews, headSha, excludedAuthor = null) {
  return [
    ...new Set(
      reviews
        .filter(
          (review) =>
            review.state === "APPROVED" &&
            review.commit?.oid === headSha &&
            typeof review.author?.login === "string" &&
            review.author.login !== excludedAuthor,
        )
        .map((review) => review.author.login),
    ),
  ];
}

export function leaderSelfReviewForHead(reviews, headSha, authorLogin, policy) {
  return (
    leaderReviewMode(policy) === "self-or-exempt" &&
    authorLogin === policy.leader &&
    reviews.some(
      (review) =>
        review.state === "APPROVED" &&
        review.commit?.oid === headSha &&
        review.author?.login === authorLogin,
    )
  );
}

export function approvalCountForHead({ reviews, headSha, authorLogin, policy }) {
  const approvedReviewers = approvedReviewersForHead(reviews, headSha, authorLogin);
  return (
    approvedReviewers.length +
    (leaderSelfReviewForHead(reviews, headSha, authorLogin, policy) ? 1 : 0)
  );
}

export function leaderParticipated({ authorLogin, reviews, headSha, policy }) {
  return (
    authorLogin === policy.leader ||
    reviews.some(
      (review) =>
        review.author?.login === policy.leader &&
        review.state === "APPROVED" &&
        review.commit?.oid === headSha,
    )
  );
}
