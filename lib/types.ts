export type CiState = "SUCCESS" | "FAILURE" | "PENDING" | "ERROR" | null;
export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
export type ReviewState =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "COMMENTED"
  | "DISMISSED"
  | "PENDING";

export type Reviewer = {
  login: string;
  state: ReviewState;
  submittedAt: string | null;
  isBot: boolean;
};
export type MergeQueueState =
  | "QUEUED"
  | "LOCKED"
  | "AWAITING_CHECKS"
  | "MERGEABLE"
  | "UNMERGEABLE"
  | null;

export type RawPr = {
  id: string;
  number: number;
  title: string;
  bodyText: string;
  url: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  repo: string;
  authorLogin: string | null;
  reviewDecision: ReviewDecision;
  reviewsCount: number;
  commentsCount: number;
  ciState: CiState;
  isInMergeQueue: boolean;
  mergeQueueState: MergeQueueState;
  requestedReviewerLogins: string[];
  requestedTeams: string[];
  reviewers: Reviewer[];
  latestCommitAt: string | null;
  hasNonAuthorHumanComment: boolean;
};

export type SeenSnapshot = {
  reviewsCount: number;
  commentsCount: number;
  ciState: CiState;
  wasReviewRequested: boolean;
  isMerged: boolean;
};

export type SeenRow = {
  pr_id: string;
  seen_at: number;
  reviews_count_at_seen: number;
  comments_count_at_seen: number;
  ci_state_at_seen: CiState;
  was_review_requested_at_seen: number;
};

export type SectionKey = "openMine" | "merged" | "awaitingMyReview";

export type DashboardPr = RawPr & {
  actionable: boolean;
  seenAt: number | null;
  jiraTickets: string[];
  primaryJira: string | null;
  mergeColumnState: "merged" | "closed" | "queued" | null;
  unaddressedReview: boolean;
  pendingReview: boolean;
  changedSinceCheckpoint: boolean;
};

export type DashboardResponse = {
  viewer: string;
  fetchedAt: number;
  sections: Record<SectionKey, DashboardPr[]>;
  changedCount: number;
  newCounts: {
    openMine: number;
    merged: number;
  };
};
