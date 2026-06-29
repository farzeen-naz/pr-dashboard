import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

let cached: string | null = null;

export async function getGithubToken(): Promise<string> {
  if (cached) return cached;

  const envToken = process.env.GITHUB_TOKEN?.trim();
  if (envToken) {
    cached = envToken;
    return envToken;
  }

  try {
    const { stdout } = await execFileP("gh", ["auth", "token"], { timeout: 5000 });
    const token = stdout.trim();
    if (!token) throw new Error("`gh auth token` returned empty");
    cached = token;
    return token;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `No GitHub token found. Set GITHUB_TOKEN env var or run \`gh auth login\` on the host. (${message})`,
    );
  }
}

export async function getViewerLogin(token: string): Promise<string> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) throw new Error(`GET /user failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { login: string };
  return json.login;
}

// org -> set of team slugs the viewer belongs to in that org
export type MyTeamMap = Map<string, Set<string>>;

let cachedTeams: MyTeamMap | null = null;

export async function getMyTeams(token: string): Promise<MyTeamMap> {
  if (cachedTeams) return cachedTeams;
  const map: MyTeamMap = new Map();
  let page = 1;
  while (true) {
    const res = await fetch(
      `https://api.github.com/user/teams?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!res.ok) throw new Error(`GET /user/teams failed: ${res.status} ${await res.text()}`);
    const teams = (await res.json()) as Array<{
      slug: string;
      organization: { login: string };
    }>;
    for (const t of teams) {
      const set = map.get(t.organization.login) ?? new Set<string>();
      set.add(t.slug);
      map.set(t.organization.login, set);
    }
    if (teams.length < 100) break;
    page++;
  }
  cachedTeams = map;
  return map;
}
