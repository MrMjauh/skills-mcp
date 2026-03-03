import { RequestError } from "@octokit/request-error";
import { cache } from "./cache";
import type { ResolvedRepoConfig } from "./config";
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

function extractFrontmatter(content: string): { title: string | null; description: string | null } {
  const fmMatch = content.match(/(?:^|\n)---\n([\s\S]*?)\n---/);
  if (!fmMatch) return { title: null, description: null };
  const fm = fmMatch[1];
  const titleMatch = fm.match(/^title:\s*(.+)$/m);
  const descMatch = fm.match(/^description:\s*(.+)$/m);
  return {
    title: titleMatch ? titleMatch[1].trim() : null,
    description: descMatch ? descMatch[1].trim() : null,
  };
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
      const { title, description } = content ? extractFrontmatter(content) : { title: null, description: null };
      return { name: title ?? name, path, description };
    }),
  );
}

export function findRepoBySlug(
  config: ResolvedConfig,
  slug: string,
): ResolvedRepoConfig | undefined {
  return config.repos.find((r) => `${r.owner}/${r.repo}` === slug);
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
  repo: ResolvedRepoConfig,
  rawName: string,
): Promise<{ content: string } | { error: string }> {
  const name = sanitizeName(rawName);
  if (!name) {
    return {
      error: `Invalid skill name: "${rawName}". Names must not be empty or contain path characters.`,
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
