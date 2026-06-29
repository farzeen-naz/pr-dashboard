// Known GitHub bot logins. Some bots show up as __typename="Bot" in GraphQL,
// others register as User accounts — so we check both the explicit list and
// the [bot] suffix, in addition to the typename when available.
const KNOWN_BOTS = new Set([
  "github-actions",
  "copilot",
  "copilot-pull-request-reviewer",
  "dependabot",
  "dependabot-preview",
  "renovate",
  "renovate-bot",
  "codecov",
  "codecov-commenter",
  "sonarcloud",
  "sonarqubecloud",
  "deepsource-autofix",
  "deepsource-io",
  "snyk-bot",
  "imgbot",
  "stale",
  "semantic-release-bot",
  "greenkeeper",
  "allcontributors",
  "pre-commit-ci",
  "mergify",
  "kodiakhq",
]);

export function isBotLogin(login: string, typename?: string): boolean {
  if (typename === "Bot") return true;
  if (login.endsWith("[bot]")) return true;
  return KNOWN_BOTS.has(login.toLowerCase());
}
