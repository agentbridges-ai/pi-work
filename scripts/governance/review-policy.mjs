export function requiredApprovalsForAuthor(authorLogin, policy) {
  return authorLogin === policy.leader ? policy.leaderApprovals : policy.nonLeaderCoreApprovals;
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
