# PR Notification Dashboard

## Context

Personal dashboard, run locally in Docker, that surfaces my GitHub PRs in four buckets (open · pending review · recently merged · assigned to me) and behaves like a notification feed: items I've already opened **grey out and sink in priority within their section** until something actionable changes — they don't disappear unless merged. A PR returns to top-priority "actionable" on: new review, new comment, CI flipped *to* failing, or re-requested as reviewer. Merged PRs are the only ones that fully disappear — 24h after I first see them post-merge.

The merged column also surfaces PRs **currently in the merge queue** (with a distinct "queued" badge) so they can move back to "open mine" if the queue throws them out.

A second view groups all PRs by Jira ticket id parsed from the title/body — implemented as a tab toggle on the same page (no second route).

Token comes from the host's `gh auth token` (already logged in as `farzeen-naz`, scopes include `repo`/`read:org`). The host shell reads it once and passes it as `GITHUB_TOKEN` env into the container.

Project lives at `~/personal_projects/pr-dashboard`, runs in Docker, isolated from the bases workspace and nc-docker stack. Local git repo only (no remote yet).

## Stack

- **Next.js 14 (App Router) + TypeScript**
- **Tailwind CSS** (bundled with `create-next-app`)
- **better-sqlite3** for persistent seen-state
- Native **`fetch`** for GitHub GraphQL (no octokit dep)
- **Docker** (`node:22-alpine` base, project bind-mounted, named volume for `node_modules` so Linux native binaries don't collide with host Mac binaries)
- **Port 4477** bound to `127.0.0.1` only — Docker holds 3000–3002, 5000–5019, 8000–8090; 4477 is clear

Manual refresh only (button + on initial page load). No timer/auto-poll.

## Layout

```
~/personal_projects/pr-dashboard/
├── package.json
├── tsconfig.json
├── next.config.mjs
├── tailwind.config.ts
├── postcss.config.mjs
├── Dockerfile                # node:22-alpine + entrypoint
├── docker-compose.yml        # service `app`, port 4477, named volume node_modules
├── .dockerignore
├── .gitignore                # data.db, node_modules, .next, .env*
├── PLAN.md                   # mirror of this file, lives in the repo
├── data.db                   # created on first run (bind-mounted via project dir)
├── lib/
│   ├── token.ts              # GITHUB_TOKEN env first, fallback to `gh auth token`
│   ├── github.ts             # GraphQL client + the search queries
│   ├── jira.ts               # ticket-id regex + extractor
│   ├── db.ts                 # better-sqlite3 init + schema migration
│   ├── seen.ts               # mark-as-seen + actionable classifier + buildDashboard
│   └── types.ts
└── app/
    ├── layout.tsx
    ├── globals.css           # Tailwind
    ├── page.tsx              # dashboard — flat-by-section OR grouped-by-jira (toggle)
    └── api/
        ├── prs/route.ts      # GET — fetch + classify; returns sections
        └── seen/route.ts     # POST { prId, snapshot } — record seen-state
```

## Data model (SQLite, `data.db`)

```sql
CREATE TABLE IF NOT EXISTS pr_seen (
  pr_id                        TEXT PRIMARY KEY,
  seen_at                      INTEGER NOT NULL,
  reviews_count_at_seen        INTEGER NOT NULL,
  comments_count_at_seen       INTEGER NOT NULL,
  ci_state_at_seen             TEXT,             -- SUCCESS | FAILURE | PENDING | ERROR | null
  was_review_requested_at_seen INTEGER NOT NULL  -- 0/1
);

CREATE TABLE IF NOT EXISTS merged_seen (
  pr_id                  TEXT PRIMARY KEY,
  first_seen_after_merge INTEGER NOT NULL        -- unix ms; anchors the 24h auto-hide
);
```

## GitHub fetching (`lib/github.ts`)

Single GraphQL request per refresh using `search` connection with three aliased sub-queries (the "pending review" UI section is a client-side filter of "open mine"). Per-PR fields:

```
id number title bodyText url isDraft createdAt updatedAt mergedAt
isInMergeQueue mergeQueueEntry { state }
repository { nameWithOwner }
author { login }
reviewDecision
reviews { totalCount }
comments { totalCount }
reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }
commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
```

| Section | GitHub search query |
|---|---|
| Open mine | `type:pr is:open author:@me archived:false` |
| Pending review | client-side filter of open mine where `reviewDecision == REVIEW_REQUIRED` and `reviewRequests` non-empty and not draft |
| Recently merged | `type:pr is:merged author:@me merged:>=YYYY-MM-DD` (3-day window); ALSO includes open PRs from "open mine" where `isInMergeQueue == true`, rendered with a "queued" badge |
| Awaiting my review | `type:pr is:open user-review-requested:@me archived:false` (`user-review-requested` excludes team-only requests) |

Queued PRs are excluded from "open mine" while they're in the queue.

Token: `lib/token.ts` reads `process.env.GITHUB_TOKEN` first (Docker mode), falls back to `gh auth token` on the host. Cached per process. If both fail, API returns 500 with "set GITHUB_TOKEN or run `gh auth login`".

## Seen / re-surface logic (`lib/seen.ts`)

For each PR, compare current snapshot vs `pr_seen` row.

**Actionable** if any:
1. No `pr_seen` row (never seen)
2. `reviews.totalCount > reviews_count_at_seen` — new review submitted
3. `comments.totalCount > comments_count_at_seen` — new comment
4. `currentCiState == 'FAILURE' && ci_state_at_seen != 'FAILURE'` — CI flipped *to* failing (any-change is not required)
5. For PRs in the awaiting-my-review section: I'm currently in `reviewRequests` AND `was_review_requested_at_seen == 0` — re-requested after I reviewed

Else **seen**. Open PRs are never removed — seen rows render greyed (50% opacity, smaller) below actionable rows in the same section. Sort within each subgroup by `updatedAt` desc.

**Merged section**:
- Include if not in `merged_seen` (never seen post-merge) OR `now − first_seen_after_merge < 24h`
- Exclude otherwise

**On PR-link click** (`POST /api/seen` with the PR's current snapshot):
- Upsert `pr_seen` with current `reviews.totalCount`, `comments.totalCount`, `ci_state`, and whether I'm currently in `reviewRequests`.
- If PR is merged and no `merged_seen` row exists, insert `merged_seen.first_seen_after_merge = now`.
- Browser then opens the GitHub URL in a new tab.

## Jira parsing (`lib/jira.ts`)

- Regex `/\b([A-Z]{2,10}-\d+)\b/g` over `title` + first ~2000 chars of `bodyText`.
- Primary ticket = first match in title, else first in body, else null.
- Shown as a small pill on each row.
- **Search input** at the top of the page does case-insensitive substring match against repo + title + every extracted ticket id.
- **View toggle** at the top: "By section" (default) ↔ "By Jira ticket" (groups dedup'd PRs by primary ticket, "no ticket" bucket at end). One route, two render modes off the same data.

## UI

Top bar: title · last-refreshed timestamp · refresh button · search input · view toggle.

Section card row: `[CI dot] [review badge] repo · #num · title  [JIRA-123]   2h ago`.

- Actionable rows: full opacity, normal weight, top of section.
- Seen rows: `opacity-50`, slightly smaller, below actionable.
- Row click intercepts navigation, POSTs `/api/seen` with snapshot, then `window.open(prUrl, '_blank')`.

Status visuals:
- CI dot: green / red / yellow / grey = success / failure / pending / none
- Review badge: green "approved", red "changes requested", amber "review required", grey "draft"
- Merge column: "merged" or "queued" pill

## Docker

Run via `docker compose up` from the project dir. Token injected from host:

```bash
GITHUB_TOKEN=$(gh auth token) docker compose up
```

Compose service binds `127.0.0.1:4477:4477`, mounts project dir to `/app`, uses a named volume for `/app/node_modules`. Container runs `npm install && npm run dev` on first start (subsequent starts skip install because the named volume persists).

Nothing connects to the user's nc-docker network or volumes; the dashboard runs on its own default compose network.

## Implementation tracker

### Done ✅
- `~/personal_projects/` created (`mkdir -p`)
- Scaffolded with `create-next-app@14 --typescript --tailwind --app --no-src-dir --no-eslint --import-alias "@/*" --use-npm`
- Installed deps: `better-sqlite3` + `@types/better-sqlite3` (skipped `@octokit/graphql`, using native `fetch`)
- Installed `fnm` via brew, installed Node 22.23.1 via fnm — **note:** this is unused now that we're going Docker; harmless but can be ignored
- Verified `better-sqlite3` loads on Node 22 (`db.prepare('SELECT x FROM t').get()` returned the inserted value)
- Wrote `lib/types.ts` — type definitions for `RawPr`, `DashboardPr`, `SeenRow`, `SectionKey`, `DashboardResponse`
- Wrote `lib/token.ts` — env-first, gh-fallback, cached per process; also exports `getViewerLogin`
- Wrote `lib/jira.ts` — `extractTickets()` and `primaryTicket()`
- Wrote `lib/db.ts` — sqlite init, `getAllSeen()`, `getAllMergedSeen()`, `upsertSeen()`
- Wrote `lib/github.ts` — GraphQL query builder, three aliased searches, `fetchAllPrs()`, normalization
- Wrote `lib/seen.ts` — `classifyActionable()`, `buildDashboard()` with section assembly, merge-queue handling, sorting (actionable first, then `updatedAt` desc)
- Wrote `app/api/prs/route.ts` — GET, calls `buildDashboard()`, returns JSON or 500 with error message
- Wrote `app/api/seen/route.ts` — POST, validates `prId`, calls `upsertSeen()`

### Not done ❌
- `app/layout.tsx` — still the scaffolded version with `next/font/local` Geist imports. Needs replacement with a simplified version (no font imports needed since we removed them from the design). **Note:** last attempt to rewrite was rejected because the path wasn't in additional working dirs; needs `~/.claude/settings.local.json` allow-rule OR `/add-dir` (unavailable in this VSCode extension) OR run-time permission grant.
- `app/page.tsx` — still the scaffolded "Welcome to Next.js" page. Needs full replacement with the dashboard (client component: top bar with refresh + search + view toggle, four section cards, click-handler POST to `/api/seen`, by-Jira grouped view).
- `app/globals.css` — currently fine (Tailwind directives + theme vars + body styles); may want to trim the Geist-font CSS variables since fonts are dropped.
- `Dockerfile` — not written. Should be `node:22-alpine` base, `WORKDIR /app`, expose 4477, default CMD `sh -c "npm install --prefer-offline --no-audit && npm run dev"`.
- `docker-compose.yml` — not written. Service `app`, image from Dockerfile, ports `127.0.0.1:4477:4477`, bind-mount `./:/app`, named volume `dashboard_node_modules:/app/node_modules`, env `GITHUB_TOKEN=${GITHUB_TOKEN}`, env `WATCHPACK_POLLING=true` for file watching across the bind mount, env `HOSTNAME=0.0.0.0`.
- `.dockerignore` — not written. Should exclude `node_modules`, `.next`, `.git`, `data.db`.
- `.gitignore` — currently the create-next-app default. Needs `data.db` and `data.db-*` (WAL/SHM files) added.
- `package.json` scripts — currently `"dev": "next dev"`. Needs `-p 4477 -H 0.0.0.0`. Optionally add `"docker:up": "GITHUB_TOKEN=$(gh auth token) docker compose up"` for convenience.
- `next.config.mjs` — likely no changes needed; verify.
- Smoke test: `docker compose up`, hit `http://localhost:4477`, confirm all four sections render with real PRs, click a PR to verify it greys, post a comment via GitHub, refresh, verify it returns to actionable.
- Git: `create-next-app` already ran `git init`; no commits yet. Need initial commit after smoke test passes.

### Decisions to revisit when resuming
- Whether to delete the local `node_modules/` on host (created when we ran `npm install` before switching to Docker). Harmless on disk but unused; ~280MB.
- Whether to delete `fnm` + Node 22 install since Docker handles Node now. Harmless but unused.
- Whether to commit `PLAN.md` to the repo or keep it gitignored. Currently the plan suggests keeping it in the repo so future sessions can find it.

## Verification

1. `cd ~/personal_projects/pr-dashboard && GITHUB_TOKEN=$(gh auth token) docker compose up` — container builds, npm install runs first time, Next.js dev server starts on `http://localhost:4477`.
2. In the browser:
   - Four sections render; my real open PRs show under "Open mine".
   - Recently merged shows PRs merged in the last 3 days plus any currently queued (queued get a distinct badge).
   - "Awaiting my review" only shows PRs where I'm requested individually (not team-only).
3. Click an open PR → opens GitHub in new tab → refresh dashboard → that PR is now greyed and sunk.
4. Leave a new comment on that PR via GitHub → refresh → PR returns to actionable.
5. Type a ticket id into search → only matching PRs visible across sections.
6. Click view toggle → PRs grouped under each ticket; "no ticket" bucket at end.
7. Click a merged PR → leave 24h → refresh → PR is gone from merged.
8. `git add -A && git commit -m "initial commit"` — first commit.

## Out of scope (deferred, explicitly)

- Auto-refresh on a timer (manual + on-open only)
- Pushing to a remote GitHub repo
- Actual Jira API integration (only ticket-id parsing now)
- Multi-user / shared state
