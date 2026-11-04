# PR Dashboard

A local dashboard for your GitHub pull requests that works like a notification feed. PRs you've already opened grey out and sink within their section until something actionable happens: a new review or comment, CI turning red, or a re-requested review.

## Sections

- **Open PRs**: PRs you authored that are still open.
- **Awaiting Review**: PRs where you or one of your teams is a requested reviewer.
- **Closed PRs**: recently merged or closed PRs, plus PRs in the merge queue. Merged PRs drop off 24h after you first see them.

A **by jira** toggle groups every PR by the Jira ticket ID found in its title or body.

## Running

Requires Docker and the [GitHub CLI](https://cli.github.com/) logged in with `repo` and `read:org` scopes.

```sh
./up -d
```

Open http://localhost:4477. `./up` reads your token from `gh auth token` and passes it to the container as `GITHUB_TOKEN`. Seen-state is stored in `data.db` (SQLite) in the project directory.

Without Docker:

```sh
npm install
npm run dev
```

## Stack

Next.js 14 (App Router), TypeScript, Tailwind CSS, better-sqlite3, GitHub GraphQL API.
