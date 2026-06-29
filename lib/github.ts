import type { RawPr, CiState, ReviewDecision, MergeQueueState, ReviewState } from "./types";
import { getGithubToken } from "./token";
import { isBotLogin } from "./bots";

const GRAPHQL_URL = "https://api.github.com/graphql";

type GraphQLPrNode = {
  id: string;
  number: number;
  title: string;
  bodyText: string | null;
  url: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  isInMergeQueue: boolean;
  mergeQueueEntry: { state: MergeQueueState } | null;
  repository: { nameWithOwner: string };
  author: { login: string } | null;
  reviewDecision: ReviewDecision;
  reviews: { totalCount: number };
  latestReviews: {
    nodes: Array<{
      author: { __typename: string; login: string } | null;
      state: ReviewState;
      submittedAt: string | null;
    }>;
  };
  comments: {
    totalCount: number;
    nodes: Array<{
      author: { __typename: string; login: string } | null;
    }>;
  };
  reviewRequests: {
    nodes: Array<{
      requestedReviewer:
        | { __typename: "User"; login: string }
        | { __typename: "Team"; slug: string }
        | { __typename: string }
        | null;
    }>;
  };
  commits: {
    nodes: Array<{
      commit: {
        committedDate: string;
        statusCheckRollup: { state: CiState } | null;
      };
    }>;
  };
};

const PR_FIELDS = `
  ... on PullRequest {
    id
    number
    title
    bodyText
    url
    isDraft
    createdAt
    updatedAt
    mergedAt
    closedAt
    isInMergeQueue
    mergeQueueEntry { state }
    repository { nameWithOwner }
    author { login }
    reviewDecision
    reviews { totalCount }
    latestReviews(first: 20) {
      nodes {
        author { __typename login }
        state
        submittedAt
      }
    }
    comments(first: 50) {
      totalCount
      nodes { author { __typename login } }
    }
    reviewRequests(first: 20) {
      nodes {
        requestedReviewer {
          __typename
          ... on User { login }
          ... on Team { slug }
        }
      }
    }
    commits(last: 1) {
      nodes {
        commit {
          committedDate
          statusCheckRollup { state }
        }
      }
    }
  }
`;

function buildQuery(searches: Array<{ alias: string; query: string }>): string {
  const blocks = searches.map(
    ({ alias, query }) => `
    ${alias}: search(type: ISSUE, first: 100, query: ${JSON.stringify(query)}) {
      nodes { ${PR_FIELDS} }
    }`,
  );
  return `query { ${blocks.join("\n")} }`;
}

function normalize(node: GraphQLPrNode): RawPr {
  return {
    id: node.id,
    number: node.number,
    title: node.title,
    bodyText: node.bodyText ?? "",
    url: node.url,
    isDraft: node.isDraft,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    mergedAt: node.mergedAt,
    closedAt: node.closedAt,
    repo: node.repository.nameWithOwner,
    authorLogin: node.author?.login ?? null,
    reviewDecision: node.reviewDecision,
    reviewsCount: node.reviews.totalCount,
    commentsCount: node.comments.totalCount,
    ciState: node.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null,
    isInMergeQueue: node.isInMergeQueue,
    mergeQueueState: node.mergeQueueEntry?.state ?? null,
    ...partitionRequests(node.reviewRequests.nodes),
    reviewers: node.latestReviews.nodes.flatMap((r) =>
      r.author?.login
        ? [
            {
              login: r.author.login,
              state: r.state,
              submittedAt: r.submittedAt,
              isBot: isBotLogin(r.author.login, r.author.__typename),
            },
          ]
        : [],
    ),
    latestCommitAt: node.commits.nodes[0]?.commit.committedDate ?? null,
    hasNonAuthorHumanComment: node.comments.nodes.some(
      (c) =>
        !!c.author?.login &&
        c.author.login !== node.author?.login &&
        !isBotLogin(c.author.login, c.author.__typename),
    ),
  };
}

function partitionRequests(
  nodes: GraphQLPrNode["reviewRequests"]["nodes"],
): { requestedReviewerLogins: string[]; requestedTeams: string[] } {
  const requestedReviewerLogins: string[] = [];
  const requestedTeams: string[] = [];
  for (const n of nodes) {
    const r = n.requestedReviewer;
    if (r?.__typename === "User" && "login" in r) requestedReviewerLogins.push(r.login);
    else if (r?.__typename === "Team" && "slug" in r) requestedTeams.push(r.slug);
  }
  return { requestedReviewerLogins, requestedTeams };
}

export type FetchedPrs = {
  openMine: RawPr[];
  recentlyClosed: RawPr[];
  awaitingMyReview: RawPr[];
};

function isoNDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

export async function fetchAllPrs(): Promise<FetchedPrs> {
  const token = await getGithubToken();
  const closedSince = isoNDaysAgo(3);
  // is:closed covers both merged and closed-without-merge.
  const query = buildQuery([
    { alias: "openMine", query: "type:pr is:open author:@me archived:false" },
    {
      alias: "recentlyClosed",
      query: `type:pr is:closed author:@me closed:>=${closedSince}`,
    },
    {
      alias: "awaitingMyReview",
      // `review-requested:@me` matches PRs requesting review from me OR a team
      // I'm in. GitHub's `user-review-requested:` syntax only matches direct
      // (non-team) requests despite the docs implying otherwise.
      query: "type:pr is:open review-requested:@me archived:false",
    },
  ]);

  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({ query }),
  });

  if (!res.ok) throw new Error(`GitHub GraphQL ${res.status}: ${await res.text()}`);

  type Body = {
    data?: {
      openMine: { nodes: GraphQLPrNode[] };
      recentlyClosed: { nodes: GraphQLPrNode[] };
      awaitingMyReview: { nodes: GraphQLPrNode[] };
    };
    errors?: Array<{ message: string }>;
  };
  const body = (await res.json()) as Body;
  if (body.errors?.length) throw new Error("GraphQL errors: " + body.errors.map((e) => e.message).join("; "));
  if (!body.data) throw new Error("GraphQL response missing `data`");

  return {
    openMine: body.data.openMine.nodes.map(normalize),
    recentlyClosed: body.data.recentlyClosed.nodes.map(normalize),
    awaitingMyReview: body.data.awaitingMyReview.nodes.map(normalize),
  };
}
