import { RequestError } from "@octokit/request-error";
import { cache } from "./cache";
import type { ResolvedConfig, ResolvedRepoConfig } from "./config";
import { createOctokit, getFileContent, listDirectory } from "./github";

function log(level: "info" | "warn" | "error", message: string): void {
  process.stderr.write(`[skills-mcp] ${level.toUpperCase()}: ${message}\n`);
}

function sanitizeName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  // Reject path traversal attempts
  if (
    trimmed.includes("..") ||
    trimmed.includes("/") ||
    trimmed.includes("\\")
  ) {
    return null;
  }
  return trimmed;
}

async function detectLayout(
  repo: ResolvedRepoConfig,
): Promise<"flat" | "nested"> {
  const layoutKey = `layout:${repo.owner}/${repo.repo}`;
  const cached = cache.getLayout(layoutKey);
  if (cached) return cached;

  const octokit = createOctokit(repo.token);
  const items = await listDirectory(
    octokit,
    repo.owner,
    repo.repo,
    repo.branch,
    repo.skillsPath,
  );

  const hasDir = items.some((i) => i.type === "dir");
  const layout = hasDir ? "nested" : "flat";
  log("info", `Detected layout for ${repo.owner}/${repo.repo}: ${layout}`);
  cache.setLayout(layoutKey, layout);
  return layout;
}

async function listSkillsForRepo(
  repo: ResolvedRepoConfig,
  ttl: number,
): Promise<{ name: string; path: string }[]> {
  const listKey = `list:${repo.owner}/${repo.repo}`;
  const cached = cache.get<{ name: string; path: string }[]>(listKey, ttl);
  if (cached) {
    log("info", `Cache hit for listSkills ${repo.owner}/${repo.repo}`);
    return cached;
  }

  const octokit = createOctokit(repo.token);
  const items = await listDirectory(
    octokit,
    repo.owner,
    repo.repo,
    repo.branch,
    repo.skillsPath,
  );
  const layout = await detectLayout(repo);

  let skills: { name: string; path: string }[];
  if (layout === "flat") {
    skills = items
      .filter(
        (i) =>
          i.type === "file" &&
          (i.name.endsWith(".md") || i.name.endsWith(".ts")),
      )
      .map((i) => ({ name: i.name.slice(0, -3), path: i.path }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } else {
    skills = items
      .filter((i) => i.type === "dir")
      .map((i) => ({ name: i.name, path: i.path }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  cache.set(listKey, skills);
  return skills;
}

export interface SkillMeta {
  name: string;
  path: string;
  description: string | null;
}

function extractDescription(content: string): string | null {
  // Handle both flat layout (--- at start) and nested layout (--- after a heading line)
  const fmMatch = content.match(/(?:^|\n)---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const descMatch = fmMatch[1].match(/^description:\s*(.+)$/m);
  return descMatch ? descMatch[1].trim() : null;
}

export async function listSkillsForRepoWithDescriptions(
  repo: ResolvedRepoConfig,
  ttl: number,
): Promise<SkillMeta[]> {
  const skills = await listSkillsForRepo(repo, ttl);
  return Promise.all(
    skills.map(async ({ name, path }) => {
      const cacheKey = `skill:${repo.owner}/${repo.repo}:${name}`;
      const cached = cache.get<string>(cacheKey, ttl);
      const content = cached
        ? cached
        : await fetchSkillFromRepo(repo, name).then((r) =>
            "error" in r ? null : r.content,
          );
      return { name, path, description: content ? extractDescription(content) : null };
    }),
  );
}

export function findRepoBySlug(
  config: ResolvedConfig,
  slug: string,
): ResolvedRepoConfig | undefined {
  return config.repos.find((r) => `${r.owner}/${r.repo}` === slug);
}

async function listAllSkillNames(config: ResolvedConfig): Promise<string[]> {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const repo of config.repos) {
    try {
      const skills = await listSkillsForRepo(repo, config.cacheTtlSeconds);
      for (const { name } of skills) {
        if (seen.has(name)) {
          log(
            "warn",
            `Skill name collision: "${name}" already seen (${repo.owner}/${repo.repo} ignored)`,
          );
        } else {
          seen.add(name);
          result.push(name);
        }
      }
    } catch (err) {
      log(
        "error",
        `Failed to list skills from ${repo.owner}/${repo.repo}: ${formatError(err)}`,
      );
    }
  }

  return result.sort();
}

async function findSkillRepo(
  config: ResolvedConfig,
  name: string,
): Promise<ResolvedRepoConfig | null> {
  for (const repo of config.repos) {
    try {
      const skills = await listSkillsForRepo(repo, config.cacheTtlSeconds);
      if (skills.some((s) => s.name === name)) return repo;
    } catch {
      // skip unavailable repos
    }
  }
  return null;
}

async function fetchSkillFromRepo(
  repo: ResolvedRepoConfig,
  name: string,
): Promise<{ content: string } | { error: string }> {
  const cacheKey = `skill:${repo.owner}/${repo.repo}:${name}`;
  const cached = cache.get<string>(cacheKey, 300);
  if (cached) return { content: cached };

  try {
    const layout = await detectLayout(repo);
    const octokit = createOctokit(repo.token);
    let content: string;

    if (layout === "flat") {
      try {
        content = await getFileContent(
          octokit,
          repo.owner,
          repo.repo,
          repo.branch,
          `${repo.skillsPath}/${name}.md`,
        );
      } catch (err) {
        if (err instanceof RequestError && err.status === 404) {
          content = await getFileContent(
            octokit,
            repo.owner,
            repo.repo,
            repo.branch,
            `${repo.skillsPath}/${name}.ts`,
          );
        } else {
          throw err;
        }
      }
    } else {
      const files = await listDirectory(
        octokit,
        repo.owner,
        repo.repo,
        repo.branch,
        `${repo.skillsPath}/${name}`,
      );
      const mdFiles = files
        .filter(
          (f) =>
            f.type === "file" &&
            (f.name.endsWith(".md") || f.name.endsWith(".ts")),
        )
        .sort((a, b) => a.name.localeCompare(b.name));

      if (mdFiles.length === 0) {
        return {
          error: `Skill "${name}" exists but has no markdown or TypeScript files.`,
        };
      }

      const parts = await Promise.all(
        mdFiles.map(async (f) => {
          const text = await getFileContent(
            octokit,
            repo.owner,
            repo.repo,
            repo.branch,
            f.path,
          );
          return `## ${f.name}\n\n${text}`;
        }),
      );
      content = parts.join("\n\n---\n\n");
    }

    cache.set(cacheKey, content);
    return { content };
  } catch (err) {
    return { error: formatError(err) };
  }
}

export async function fetchSkill(
  config: ResolvedConfig,
  rawName: string,
): Promise<{ content: string } | { error: string }> {
  const name = sanitizeName(rawName);
  if (!name) {
    return {
      error: `Invalid skill name: "${rawName}". Names must not be empty or contain path characters.`,
    };
  }

  const repo = await findSkillRepo(config, name);
  if (!repo) {
    return {
      error: `Skill not found: "${name}". Run listSkills to see available skills.`,
    };
  }

  return fetchSkillFromRepo(repo, name);
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
      const resetTime = reset
        ? new Date(Number(reset) * 1000).toISOString()
        : "unknown";
      return `GitHub rate limit exceeded. Resets at ${resetTime}. Add a token to increase your limit.`;
    }
    return `GitHub API error (${status}): ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
