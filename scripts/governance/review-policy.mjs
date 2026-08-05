const coreAuthorAssociations = new Set(["COLLABORATOR", "MEMBER", "OWNER"]);

export function isCoreAuthor(authorLogin, policy, authorAssociation = "MEMBER") {
  return authorLogin === policy.leader || coreAuthorAssociations.has(authorAssociation);
}

export function requiredApprovalsForAuthor(authorLogin, policy, authorAssociation = "MEMBER") {
  if (authorLogin === policy.leader) return policy.leaderApprovals;
  if (isCoreAuthor(authorLogin, policy, authorAssociation)) return policy.nonLeaderCoreApprovals;
  return policy.ordinaryApprovals;
}

export function approvedReviewersForHead(reviews, headSha) {
  return [
    ...new Set(
      reviews
        .filter(
          (review) =>
            review.state === "APPROVED" &&
            review.commit?.oid === headSha &&
            typeof review.author?.login === "string",
        )
        .map((review) => review.author.login),
    ),
  ];
}
