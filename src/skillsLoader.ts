import { ResolvedConfig, ResolvedRepoConfig } from "./config.js";
import { cache } from "./cache.js";
import { createOctokit, listDirectory, getFileContent } from "./github.js";
import { RequestError } from "@octokit/request-error";

function log(level: "info" | "warn" | "error", message: string): void {
  process.stderr.write(`[skills-mcp] ${level.toUpperCase()}: ${message}\n`);
}

function sanitizeName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  // Reject path traversal attempts
  if (trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\")) {
    return null;
  }
  return trimmed;
}

async function detectLayout(
  repo: ResolvedRepoConfig
): Promise<"flat" | "nested"> {
  const layoutKey = `layout:${repo.owner}/${repo.repo}`;
  const cached = cache.getLayout(layoutKey);
  if (cached) return cached;

  const octokit = createOctokit(repo.token);
  const items = await listDirectory(octokit, repo.owner, repo.repo, repo.branch, repo.skillsPath);

  const hasDir = items.some((i) => i.type === "dir");
  const layout = hasDir ? "nested" : "flat";
  log("info", `Detected layout for ${repo.owner}/${repo.repo}: ${layout}`);
  cache.setLayout(layoutKey, layout);
  return layout;
}

export interface SkillRef {
  name: string;
  repo: ResolvedRepoConfig;
}

async function listSkillsForRepo(
  repo: ResolvedRepoConfig,
  ttl: number
): Promise<string[]> {
  const listKey = `list:${repo.owner}/${repo.repo}`;
  const cached = cache.get<string[]>(listKey, ttl);
  if (cached) {
    log("info", `Cache hit for listSkills ${repo.owner}/${repo.repo}`);
    return cached;
  }

  const octokit = createOctokit(repo.token);
  const items = await listDirectory(octokit, repo.owner, repo.repo, repo.branch, repo.skillsPath);
  const layout = await detectLayout(repo);

  let names: string[];
  if (layout === "flat") {
    names = items
      .filter((i) => i.type === "file" && i.name.endsWith(".md"))
      .map((i) => i.name.slice(0, -3))
      .sort();
  } else {
    names = items
      .filter((i) => i.type === "dir")
      .map((i) => i.name)
      .sort();
  }

  cache.set(listKey, names);
  return names;
}

export async function listAllSkills(config: ResolvedConfig): Promise<string[]> {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const repo of config.repos) {
    try {
      const names = await listSkillsForRepo(repo, config.cacheTtlSeconds);
      for (const name of names) {
        if (seen.has(name)) {
          log("warn", `Skill name collision: "${name}" already seen (${repo.owner}/${repo.repo} ignored)`);
        } else {
          seen.add(name);
          result.push(name);
        }
      }
    } catch (err) {
      log("error", `Failed to list skills from ${repo.owner}/${repo.repo}: ${formatError(err)}`);
    }
  }

  return result.sort();
}

async function findSkillRepo(
  config: ResolvedConfig,
  name: string
): Promise<ResolvedRepoConfig | null> {
  for (const repo of config.repos) {
    try {
      const names = await listSkillsForRepo(repo, config.cacheTtlSeconds);
      if (names.includes(name)) return repo;
    } catch {
      // skip unavailable repos
    }
  }
  return null;
}

export async function fetchSkill(
  config: ResolvedConfig,
  rawName: string
): Promise<{ content: string } | { error: string }> {
  const name = sanitizeName(rawName);
  if (!name) {
    return { error: `Invalid skill name: "${rawName}". Names must not be empty or contain path characters.` };
  }

  const cacheKey = `skill:${name}`;
  const cached = cache.get<string>(cacheKey, config.cacheTtlSeconds);
  if (cached) {
    log("info", `Cache hit for skill "${name}"`);
    return { content: cached };
  }

  const repo = await findSkillRepo(config, name);
  if (!repo) {
    return { error: `Skill not found: "${name}". Run listSkills to see available skills.` };
  }

  const repoKey = `skill:${repo.owner}/${repo.repo}:${name}`;
  const repoCache = cache.get<string>(repoKey, config.cacheTtlSeconds);
  if (repoCache) return { content: repoCache };

  try {
    const layout = await detectLayout(repo);
    const octokit = createOctokit(repo.token);
    let content: string;

    if (layout === "flat") {
      content = await getFileContent(
        octokit, repo.owner, repo.repo, repo.branch,
        `${repo.skillsPath}/${name}.md`
      );
    } else {
      const files = await listDirectory(
        octokit, repo.owner, repo.repo, repo.branch,
        `${repo.skillsPath}/${name}`
      );
      const mdFiles = files
        .filter((f) => f.type === "file" && f.name.endsWith(".md"))
        .sort((a, b) => a.name.localeCompare(b.name));

      if (mdFiles.length === 0) {
        return { error: `Skill "${name}" exists but has no markdown files.` };
      }

      const parts = await Promise.all(
        mdFiles.map(async (f) => {
          const text = await getFileContent(
            octokit, repo.owner, repo.repo, repo.branch, f.path
          );
          return `## ${f.name}\n\n${text}`;
        })
      );
      content = parts.join("\n\n---\n\n");
    }

    cache.set(repoKey, content);
    return { content };
  } catch (err) {
    return { error: formatError(err) };
  }
}

function formatError(err: unknown): string {
  if (err instanceof RequestError) {
    const status = err.status;
    if (status === 401 || status === 403) {
      return `GitHub auth error (${status}): A valid token is required. Set GITHUB_TOKEN or add a "token" field to the repo config.`;
    }
    if (status === 404) {
      return `GitHub 404: Repository or path not found. Check owner, repo, branch, and skillsPath in config.`;
    }
    if (status === 429) {
      const reset = err.response?.headers?.["x-ratelimit-reset"];
      const resetTime = reset ? new Date(Number(reset) * 1000).toISOString() : "unknown";
      return `GitHub rate limit exceeded. Resets at ${resetTime}. Add a token to increase your limit.`;
    }
    return `GitHub API error (${status}): ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
