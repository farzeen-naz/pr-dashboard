"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type {
  CiState,
  DashboardPr,
  DashboardResponse,
  Reviewer,
  ReviewState,
  SectionKey,
} from "@/lib/types";

const JIRA_BASE = "https://optimizely-ext.atlassian.net/browse";
const jiraUrl = (ticket: string) => `${JIRA_BASE}/${ticket}`;

const PILL_BASE = "text-[10px] px-1.5 py-0.5 rounded shrink-0";

const REVIEW_STATE_CLS: Record<ReviewState, string> = {
  APPROVED: "bg-green-100 text-green-700",
  CHANGES_REQUESTED: "bg-red-100 text-red-700",
  COMMENTED: "bg-zinc-100 text-zinc-600",
  DISMISSED: "bg-zinc-100 text-zinc-400 line-through",
  PENDING: "bg-amber-100 text-amber-700",
};

// Sort: most-decisive states first
const REVIEW_STATE_RANK: Record<ReviewState, number> = {
  CHANGES_REQUESTED: 0,
  APPROVED: 1,
  COMMENTED: 2,
  PENDING: 3,
  DISMISSED: 4,
};

const CI_BADGE: Record<NonNullable<CiState>, { label: string; variant: string }> = {
  SUCCESS: { label: "ci pass", variant: "bg-green-100 text-green-700" },
  FAILURE: { label: "ci fail", variant: "bg-red-100 text-red-700" },
  ERROR: { label: "ci error", variant: "bg-red-100 text-red-700" },
  PENDING: { label: "ci pending", variant: "bg-amber-100 text-amber-700" },
};

const SECTION_TITLES: Record<SectionKey, string> = {
  openMine: "Open PRs",
  merged: "Closed PRs",
  awaitingMyReview: "Awaiting Review",
};

const SECTION_ORDER: SectionKey[] = ["openMine", "awaitingMyReview", "merged"];

// by-jira view shows only PRs I authored. "Awaiting my review" is other people's PRs.
const MINE_ONLY_SECTIONS: SectionKey[] = ["openMine", "merged"];

type ViewMode = "section" | "jira";

export default function Page() {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<ViewMode>("section");
  const [awaitingTab, setAwaitingTab] = useState<"individual" | "team">("individual");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/prs", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData(json as DashboardResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleOpen = useCallback(
    async (pr: DashboardPr, viewer: string) => {
      window.open(pr.url, "_blank", "noopener,noreferrer");
      try {
        await fetch("/api/seen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prId: pr.id,
            reviewsCount: pr.reviewsCount,
            commentsCount: pr.commentsCount,
            ciState: pr.ciState,
            wasReviewRequested: pr.requestedReviewerLogins.includes(viewer),
            // isMerged drives the 24h-after-seen hide rule; trigger it for any
            // closed PR (merged or not), since both belong in the closed column.
            isMerged: !!pr.closedAt,
          }),
        });
      } catch {
        /* best-effort — don't block the tab open */
      }
      setData((prev) => {
        if (!prev) return prev;
        const now = Date.now();
        const nextSections = { ...prev.sections } as DashboardResponse["sections"];
        for (const key of Object.keys(nextSections) as SectionKey[]) {
          nextSections[key] = nextSections[key].map((row) =>
            row.id === pr.id ? { ...row, actionable: false, seenAt: now } : row,
          );
        }
        return { ...prev, sections: nextSections };
      });
    },
    [],
  );

  const filteredSections = useMemo(() => {
    if (!data) return null;
    const q = search.trim().toLowerCase();
    const filter = (rows: DashboardPr[]) =>
      !q
        ? rows
        : rows.filter((pr) => {
            if (pr.repo.toLowerCase().includes(q)) return true;
            if (pr.title.toLowerCase().includes(q)) return true;
            return pr.jiraTickets.some((t) => t.toLowerCase().includes(q));
          });
    const out = {} as DashboardResponse["sections"];
    for (const key of SECTION_ORDER) out[key] = filter(data.sections[key]);
    return out;
  }, [data, search]);

  const jiraGroups = useMemo(() => {
    if (!filteredSections) return null;
    const byId = new Map<string, DashboardPr>();
    for (const key of MINE_ONLY_SECTIONS) {
      for (const pr of filteredSections[key]) {
        if (!byId.has(pr.id)) byId.set(pr.id, pr);
      }
    }
    const groups = new Map<string, DashboardPr[]>();
    for (const pr of byId.values()) {
      const k = pr.primaryJira ?? "__none__";
      const arr = groups.get(k) ?? [];
      arr.push(pr);
      groups.set(k, arr);
    }
    const sortGroup = (rows: DashboardPr[]) =>
      [...rows].sort((a, b) => {
        const aClosed = !!a.closedAt;
        const bClosed = !!b.closedAt;
        if (aClosed !== bClosed) return aClosed ? 1 : -1;
        return b.updatedAt.localeCompare(a.updatedAt);
      });
    // Groups with a higher share of merged PRs sink toward the bottom;
    // among ties, the one with the most-recent activity wins. "no ticket" stays last.
    const tickets = [...groups.keys()].filter((k) => k !== "__none__");
    tickets.sort((a, b) => {
      const ga = groups.get(a) ?? [];
      const gb = groups.get(b) ?? [];
      const ra = ga.filter((p) => p.closedAt).length / ga.length;
      const rb = gb.filter((p) => p.closedAt).length / gb.length;
      if (ra !== rb) return ra - rb;
      const ua = ga.reduce((m, p) => (p.updatedAt > m ? p.updatedAt : m), "");
      const ub = gb.reduce((m, p) => (p.updatedAt > m ? p.updatedAt : m), "");
      return ub.localeCompare(ua);
    });
    const ordered: Array<{ ticket: string | null; prs: DashboardPr[] }> = tickets.map(
      (t) => ({ ticket: t, prs: sortGroup(groups.get(t) ?? []) }),
    );
    if (groups.has("__none__")) {
      ordered.push({ ticket: null, prs: sortGroup(groups.get("__none__") ?? []) });
    }
    return ordered;
  }, [filteredSections]);

  return (
    <div className="min-h-screen px-6 py-5 max-w-6xl mx-auto">
      <header className="flex flex-wrap items-center gap-3 mb-6">
        <h1 className="text-lg font-semibold">PR Dashboard</h1>
        {data?.viewer && (
          <span className="text-xs text-zinc-500">@{data.viewer}</span>
        )}
        <span className="text-xs text-zinc-500">
          {data
            ? `fetched ${new Date(data.fetchedAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}`
            : "—"}
        </span>
        {data && data.changedCount > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">
            {data.changedCount} new changes since last fetch
          </span>
        )}
        <div className="flex-1" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="search repo · title · JIRA-123"
          className="px-2 py-1 text-sm rounded border border-zinc-300 bg-transparent w-64"
        />
        <ViewToggle value={view} onChange={setView} />
        <button
          onClick={() => void refresh()}
          disabled={loading}
          className="px-3 py-1 text-sm rounded border border-zinc-300 hover:bg-zinc-100 disabled:opacity-50 inline-flex items-center gap-1.5"
        >
          {loading && (
            <span className="inline-block w-3 h-3 border-2 border-zinc-400 border-t-transparent rounded-full animate-spin" />
          )}
          refresh
        </button>
      </header>

      {error && (
        <div className="mb-4 p-3 rounded border border-red-400 text-red-600 text-sm">
          {error}
        </div>
      )}

      {!data && !error && (
        <div className="text-sm text-zinc-500">loading…</div>
      )}

      {data && filteredSections && view === "section" && (
        <div className="space-y-6">
          {SECTION_ORDER.map((key) => {
            const isAwaiting = key === "awaitingMyReview";
            const sectionProps =
              isAwaiting && awaitingTab === "team"
                ? { groups: groupAwaitingByTeam(filteredSections[key]) }
                : isAwaiting
                  ? {
                      prs: filterAwaitingIndividual(
                        filteredSections[key],
                        data.viewer,
                      ),
                    }
                  : { prs: filteredSections[key] };
            return (
              <Section
                key={key}
                title={SECTION_TITLES[key]}
                viewer={data.viewer}
                onOpen={handleOpen}
                {...sectionProps}
                headerExtra={
                  isAwaiting ? (
                    <AwaitingTabs
                      value={awaitingTab}
                      onChange={setAwaitingTab}
                      counts={countAwaiting(filteredSections[key], data.viewer)}
                      viewer={data.viewer}
                    />
                  ) : null
                }
              />
            );
          })}
        </div>
      )}

      {data && jiraGroups && view === "jira" && (
        <div className="space-y-6">
          {jiraGroups.map(({ ticket, prs }) => (
            <Section
              key={ticket ?? "__none__"}
              title={
                ticket ? (
                  <a
                    href={jiraUrl(ticket)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline"
                    title={`open ${ticket} in Jira`}
                  >
                    {ticket}
                  </a>
                ) : (
                  "no ticket"
                )
              }
              prs={prs}
              viewer={data.viewer}
              onOpen={handleOpen}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ViewToggle({
  value,
  onChange,
}: {
  value: ViewMode;
  onChange: (v: ViewMode) => void;
}) {
  return (
    <div className="inline-flex text-xs rounded border border-zinc-300 overflow-hidden">
      {(["section", "jira"] as const).map((mode) => (
        <button
          key={mode}
          onClick={() => onChange(mode)}
          className={`px-2 py-1 ${
            value === mode
              ? "bg-zinc-200"
              : "hover:bg-zinc-100"
          }`}
        >
          {mode === "section" ? "by section" : "by jira"}
        </button>
      ))}
    </div>
  );
}

type TeamGroup = { label: string; prs: DashboardPr[] };

function Section({
  title,
  prs,
  groups,
  viewer,
  onOpen,
  headerExtra = null,
}: {
  title: React.ReactNode;
  prs?: DashboardPr[];
  groups?: TeamGroup[];
  viewer: string;
  onOpen: (pr: DashboardPr, viewer: string) => void;
  headerExtra?: React.ReactNode;
}) {
  const totalCount = groups
    ? groups.reduce((n, g) => n + g.prs.length, 0)
    : (prs?.length ?? 0);
  return (
    <section className="rounded-lg border border-zinc-200">
      <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-200">
        <h2 className="text-sm font-medium">{title}</h2>
        <div className="flex items-center gap-3">
          {headerExtra}
          <span className="text-xs text-zinc-500">{totalCount}</span>
        </div>
      </div>
      {totalCount === 0 ? (
        <div className="px-4 py-3 text-xs text-zinc-500">nothing here</div>
      ) : (
        <>
          <ColumnHeader />
          <ul>
            {groups
              ? groups.map((g) => (
                  <Fragment key={g.label}>
                    <li className="px-4 py-1.5 bg-zinc-50 text-xs font-medium text-sky-700 border-t border-zinc-100">
                      @{g.label}{" "}
                      <span className="text-zinc-400 font-normal">
                        ({g.prs.length})
                      </span>
                    </li>
                    {g.prs.map((pr) => (
                      <Row
                        key={`${g.label}-${pr.id}`}
                        pr={pr}
                        viewer={viewer}
                        onOpen={onOpen}
                      />
                    ))}
                  </Fragment>
                ))
              : (prs ?? []).map((pr) => (
                  <Row key={pr.id} pr={pr} viewer={viewer} onOpen={onOpen} />
                ))}
          </ul>
        </>
      )}
    </section>
  );
}

function Row({
  pr,
  viewer,
  onOpen,
}: {
  pr: DashboardPr;
  viewer: string;
  onOpen: (pr: DashboardPr, viewer: string) => void;
}) {
  return (
    <li
      className={`flex items-start gap-3 px-4 py-2 border-t first:border-t-0 border-zinc-100 cursor-pointer ${
        pr.actionable
          ? "bg-blue-50 hover:bg-blue-100"
          : "hover:bg-zinc-50"
      }`}
      onClick={(e) => {
        e.preventDefault();
        onOpen(pr, viewer);
      }}
    >
      <div className="shrink-0 w-28 flex flex-col items-start gap-1">
        {pr.changedSinceCheckpoint && (
          <Pill
            variant="bg-blue-100 text-blue-700"
            title="updated since the previous fetch"
          >
            new changes
          </Pill>
        )}
        {/* fail/warning first, success/neutral after */}
        {(pr.ciState === "FAILURE" || pr.ciState === "ERROR") && (
          <CiBadge state={pr.ciState} />
        )}
        {pr.unaddressedReview && (
          <Pill
            variant="bg-orange-100 text-orange-700"
            title="review not addressed — no new commits since the last comment/changes-requested"
          >
            unaddressed
          </Pill>
        )}
        {pr.ciState === "PENDING" && <CiBadge state={pr.ciState} />}
        {pr.mergeColumnState === "queued" && (
          <Pill variant="bg-amber-100 text-amber-700">queued</Pill>
        )}
        {pr.ciState === "SUCCESS" && <CiBadge state={pr.ciState} />}
        {pr.isDraft && <Pill variant="bg-zinc-200 text-zinc-700">draft</Pill>}
        {!!pr.mergedAt && (
          <Pill variant="bg-purple-100 text-purple-700">merged</Pill>
        )}
        {!pr.mergedAt && !!pr.closedAt && (
          <Pill variant="bg-zinc-200 text-zinc-700">closed</Pill>
        )}
      </div>
      <div
        className="shrink-0 w-32 overflow-hidden"
        title={pr.repo}
      >
        <span className="text-xs text-zinc-500 block truncate">
          {pr.repo.split("/")[1] ?? pr.repo}
        </span>
      </div>
      <span className="text-xs text-zinc-400 shrink-0">#{pr.number}</span>
      <span className="truncate flex-1 min-w-0">{pr.title}</span>
      <div className="shrink-0 w-40 flex flex-col items-end gap-1">
        {pr.pendingReview && (
          <Pill
            variant="bg-amber-100 text-amber-700"
            title="awaiting first human review — no human reviews or comments yet"
          >
            pending
          </Pill>
        )}
        <Reviewers reviewers={pr.reviewers} showApprovedTick={!pr.mergedAt} />
      </div>
      <div className="shrink-0 w-20 flex justify-end">
        {pr.primaryJira && (
          <Pill
            variant="bg-blue-100 text-blue-700 hover:underline"
            href={jiraUrl(pr.primaryJira)}
            title={`open ${pr.primaryJira} in Jira`}
            onClick={(e) => e.stopPropagation()}
          >
            {pr.primaryJira}
          </Pill>
        )}
      </div>
      <span
        className="text-xs text-zinc-500 shrink-0 w-10 text-right tabular-nums"
        title={`opened ${new Date(pr.createdAt).toLocaleString()}`}
      >
        {daysOpen(pr.createdAt, pr.closedAt)}d
      </span>
      <span className="text-xs text-zinc-500 shrink-0 w-16 text-right">
        {formatRelative(new Date(pr.updatedAt).getTime())}
      </span>
    </li>
  );
}

type AwaitingTab = "individual" | "team";

function filterAwaitingIndividual(
  rows: DashboardPr[],
  viewer: string,
): DashboardPr[] {
  return rows.filter((p) => p.requestedReviewerLogins.includes(viewer));
}

function groupAwaitingByTeam(rows: DashboardPr[]): TeamGroup[] {
  const map = new Map<string, DashboardPr[]>();
  for (const pr of rows) {
    for (const team of pr.requestedTeams) {
      const arr = map.get(team) ?? [];
      arr.push(pr);
      map.set(team, arr);
    }
  }
  return [...map.keys()]
    .sort()
    .map((label) => ({
      label,
      prs: (map.get(label) ?? []).sort((a, b) => {
        if (a.actionable !== b.actionable) return a.actionable ? -1 : 1;
        return b.updatedAt.localeCompare(a.updatedAt);
      }),
    }));
}

function countAwaiting(rows: DashboardPr[], viewer: string) {
  let individual = 0;
  let team = 0;
  for (const p of rows) {
    if (p.requestedReviewerLogins.includes(viewer)) individual++;
    if (p.requestedTeams.length > 0) team++;
  }
  return { individual, team };
}

function AwaitingTabs({
  value,
  onChange,
  counts,
  viewer,
}: {
  value: AwaitingTab;
  onChange: (v: AwaitingTab) => void;
  counts: { individual: number; team: number };
  viewer: string;
}) {
  const label: Record<AwaitingTab, string> = { individual: viewer, team: "team" };
  return (
    <div className="inline-flex text-xs rounded border border-zinc-300 overflow-hidden">
      {(["individual", "team"] as const).map((t) => (
        <button
          key={t}
          onClick={() => onChange(t)}
          className={`px-2 py-1 ${
            value === t
              ? "bg-zinc-200"
              : "hover:bg-zinc-100"
          }`}
        >
          {label[t]} ({counts[t]})
        </button>
      ))}
    </div>
  );
}

function ColumnHeader() {
  const lbl = "text-[10px] uppercase tracking-wide text-zinc-400 shrink-0";
  return (
    <div className="flex items-center gap-3 px-4 py-1 border-b border-zinc-100 bg-zinc-50/60">
      <span className={`${lbl} w-28`}>status</span>
      <span className={`${lbl} w-32`}>repo</span>
      <span className={`${lbl} flex-1 min-w-0`}>title</span>
      <span className={`${lbl} w-40 text-right`}>reviewers</span>
      <span className={`${lbl} w-20 text-right`}>jira</span>
      <span className={`${lbl} w-10 text-right`}>open</span>
      <span className={`${lbl} w-16 text-right`}>updated</span>
    </div>
  );
}

function Pill({
  variant,
  title,
  href,
  onClick,
  children,
}: {
  variant: string;
  title?: string;
  href?: string;
  onClick?: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  const cls = `${PILL_BASE} ${variant}`;
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={onClick}
        className={cls}
        title={title}
      >
        {children}
      </a>
    );
  }
  return (
    <span className={cls} title={title}>
      {children}
    </span>
  );
}

function displayReviewer(login: string): string {
  return /copilot/i.test(login) ? "co-pilot" : login;
}

function Reviewers({
  reviewers,
  showApprovedTick,
}: {
  reviewers: Reviewer[];
  showApprovedTick: boolean;
}) {
  if (reviewers.length === 0) return null;
  const sorted = [...reviewers].sort(
    (a, b) => REVIEW_STATE_RANK[a.state] - REVIEW_STATE_RANK[b.state],
  );
  const hasApproval =
    showApprovedTick && reviewers.some((r) => r.state === "APPROVED" && !r.isBot);
  return (
    <>
      {hasApproval && (
        <Pill variant="bg-green-100 text-green-700" title="approved">✓</Pill>
      )}
      {sorted.map((r) => (
        <Pill
          key={r.login}
          variant={REVIEW_STATE_CLS[r.state]}
          title={`${r.login}: ${r.state.toLowerCase()}`}
        >
          {displayReviewer(r.login)}
        </Pill>
      ))}
    </>
  );
}

function CiBadge({ state }: { state: CiState }) {
  if (state === null) return null;
  const { label, variant } = CI_BADGE[state];
  return (
    <Pill variant={variant} title={`CI ${state.toLowerCase()}`}>
      {label}
    </Pill>
  );
}

function daysOpen(createdAt: string, closedAt: string | null): number {
  const end = closedAt ? new Date(closedAt).getTime() : Date.now();
  const ms = end - new Date(createdAt).getTime();
  return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}
