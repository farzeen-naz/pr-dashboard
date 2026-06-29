import type { RawPr, DashboardPr, DashboardResponse, SectionKey, SeenRow } from "./types";
import {
  getAllSeen,
  getAllMergedSeen,
  getAllCheckpoints,
  getMeta,
  replaceCheckpoint,
} from "./db";
import { primaryTicket, extractTickets } from "./jira";
import { fetchAllPrs } from "./github";
import { getViewerLogin, getGithubToken, getMyTeams, type MyTeamMap } from "./token";

const MERGED_HIDE_AFTER_MS = 24 * 60 * 60 * 1000;
const STALE_HIDE_AFTER_MS = 15 * 24 * 60 * 60 * 1000;

function classifyActionable(
  pr: RawPr,
  viewer: string,
  seenRow: SeenRow | undefined,
  isAwaitingReviewSection: boolean,
): boolean {
  if (!seenRow) return true;
  if (pr.reviewsCount > seenRow.reviews_count_at_seen) return true;
  if (pr.commentsCount > seenRow.comments_count_at_seen) return true;
  if (pr.ciState === "FAILURE" && seenRow.ci_state_at_seen !== "FAILURE") return true;
  if (isAwaitingReviewSection) {
    const currentlyRequested = pr.requestedReviewerLogins.includes(viewer);
    if (currentlyRequested && seenRow.was_review_requested_at_seen === 0) return true;
  }
  return false;
}

// "Unaddressed" = a reviewer submitted CHANGES_REQUESTED or COMMENTED
// after the latest commit. APPROVED/DISMISSED/PENDING don't require a reply.
function isReviewUnaddressed(pr: RawPr): boolean {
  if (pr.mergedAt || pr.closedAt || !pr.latestCommitAt) return false;
  return pr.reviewers.some(
    (r) =>
      !r.isBot &&
      (r.state === "CHANGES_REQUESTED" || r.state === "COMMENTED") &&
      r.submittedAt !== null &&
      r.submittedAt > pr.latestCommitAt!,
  );
}

// "Pending review" = the PR is open, not a draft, has review-required decision,
// and no human has engaged yet (no human reviews, no non-author human comments).
// Copilot/bot reviews and comments don't count.
function isPendingReview(pr: RawPr): boolean {
  return (
    !pr.mergedAt &&
    !pr.closedAt &&
    !pr.isDraft &&
    pr.reviewDecision === "REVIEW_REQUIRED" &&
    !pr.reviewers.some((r) => !r.isBot) &&
    !pr.hasNonAuthorHumanComment
  );
}

function makeRow(
  pr: RawPr,
  row: SeenRow | undefined,
  actionable: boolean,
  mergeColumnState: DashboardPr["mergeColumnState"],
  checkpointUpdatedAt: string | undefined,
  checkpointInitialized: boolean,
): DashboardPr {
  // "Changed since checkpoint" = the PR's GitHub `updatedAt` is newer than what
  // we recorded last time the user advanced the checkpoint. New PRs (absent from
  // the checkpoint) also count. On the very first run ever, nothing is flagged.
  const changedSinceCheckpoint =
    checkpointInitialized &&
    (checkpointUpdatedAt === undefined || pr.updatedAt > checkpointUpdatedAt);
  return {
    ...pr,
    jiraTickets: extractTickets(pr.title, pr.bodyText),
    primaryJira: primaryTicket(pr.title, pr.bodyText),
    unaddressedReview: isReviewUnaddressed(pr),
    pendingReview: isPendingReview(pr),
    actionable,
    seenAt: row?.seen_at ?? null,
    mergeColumnState,
    changedSinceCheckpoint,
  };
}

// Trim `requestedTeams` to teams the viewer belongs to in the PR's org —
// other teams are noise for this user.
function filterMyTeams(pr: RawPr, myTeams: MyTeamMap): RawPr {
  const org = pr.repo.split("/")[0];
  const mine = myTeams.get(org);
  if (!mine || pr.requestedTeams.every((t) => mine.has(t))) return pr;
  return { ...pr, requestedTeams: pr.requestedTeams.filter((t) => mine.has(t)) };
}

export async function buildDashboard(): Promise<DashboardResponse> {
  const token = await getGithubToken();
  const [viewer, fetched, myTeams] = await Promise.all([
    getViewerLogin(token),
    fetchAllPrs(),
    getMyTeams(token),
  ]);

  const seen = getAllSeen();
  const mergedSeen = getAllMergedSeen();
  const checkpoint = getAllCheckpoints();
  const checkpointInitialized = getMeta("checkpoint_initialized") === "1";
  const now = Date.now();

  const sections: Record<SectionKey, DashboardPr[]> = {
    openMine: [],
    merged: [],
    awaitingMyReview: [],
  };

  for (const raw of fetched.recentlyClosed) {
    const pr = filterMyTeams(raw, myTeams);
    const seenAfterClose = mergedSeen.get(pr.id);
    if (seenAfterClose !== undefined && now - seenAfterClose >= MERGED_HIDE_AFTER_MS) continue;
    const row = seen.get(pr.id);
    sections.merged.push(makeRow(pr, row, !row, pr.mergedAt ? "merged" : "closed", checkpoint.get(pr.id), checkpointInitialized));
  }

  for (const raw of fetched.openMine) {
    const pr = filterMyTeams(raw, myTeams);
    const row = seen.get(pr.id);
    const actionable = classifyActionable(pr, viewer, row, false);
    const mergeColumnState = pr.isInMergeQueue ? "queued" : null;
    const item = makeRow(pr, row, actionable, mergeColumnState, checkpoint.get(pr.id), checkpointInitialized);
    if (pr.isInMergeQueue) sections.merged.push(item);
    else sections.openMine.push(item);
  }

  for (const raw of fetched.awaitingMyReview) {
    const pr = filterMyTeams(raw, myTeams);
    // Hide any PR in this section that's been stale for >15 days — individual
    // or team-tagged, doesn't matter. Two weeks of no activity = abandoned.
    if (now - new Date(pr.updatedAt).getTime() > STALE_HIDE_AFTER_MS) continue;
    const row = seen.get(pr.id);
    sections.awaitingMyReview.push(
      makeRow(pr, row, classifyActionable(pr, viewer, row, true), null, checkpoint.get(pr.id), checkpointInitialized),
    );
  }

  // Sort each section in place; in the same pass, accumulate the snapshot
  // (id → updatedAt) and count distinct PRs that changed since checkpoint.
  // Sections are mutually exclusive by construction (author can't review their
  // own PR; queued PRs go to merged only).
  const snapshot: Array<{ id: string; updatedAt: string }> = [];
  let changedCount = 0;
  for (const key of Object.keys(sections) as SectionKey[]) {
    sections[key].sort((a, b) => {
      if (a.actionable !== b.actionable) return a.actionable ? -1 : 1;
      // In open-mine, pending-review (no human engagement yet) sinks to the bottom.
      if (key === "openMine" && a.pendingReview !== b.pendingReview) {
        return a.pendingReview ? 1 : -1;
      }
      // In awaiting-my-review, individually-requested PRs rank above team-only.
      if (key === "awaitingMyReview") {
        const aIndividual = a.requestedReviewerLogins.includes(viewer);
        const bIndividual = b.requestedReviewerLogins.includes(viewer);
        if (aIndividual !== bIndividual) return aIndividual ? -1 : 1;
      }
      return b.updatedAt.localeCompare(a.updatedAt);
    });
    for (const p of sections[key]) {
      snapshot.push({ id: p.id, updatedAt: p.updatedAt });
      if (p.changedSinceCheckpoint) changedCount++;
    }
  }
  replaceCheckpoint(snapshot);

  return { viewer, fetchedAt: now, sections, changedCount };
}
