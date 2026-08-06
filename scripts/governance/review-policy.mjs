const coreAuthorAssociations = new Set(["COLLABORATOR", "MEMBER", "OWNER"]);

export function isCoreAuthor(authorLogin, policy, authorAssociation = "MEMBER") {
  return authorLogin === policy.leader || coreAuthorAssociations.has(authorAssociation);
}

export function requiredApprovalsForAuthor(authorLogin, policy, authorAssociation = "MEMBER") {
  if (authorLogin === policy.leader) return policy.leaderApprovals;
  if (isCoreAuthor(authorLogin, policy, authorAssociation)) return policy.nonLeaderCoreApprovals;
  return policy.ordinaryApprovals;
}

export function leaderAuthorCountsAsApproval(authorLogin, policy) {
  return authorLogin === policy.leader && policy.leaderSelfApproval === true;
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

export function approvalCountForHead({ reviews, headSha, authorLogin, policy }) {
  const approvedReviewers = approvedReviewersForHead(reviews, headSha, authorLogin);
  return approvedReviewers.length + (leaderAuthorCountsAsApproval(authorLogin, policy) ? 1 : 0);
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
