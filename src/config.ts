import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

export interface RepoConfig {
  owner: string;
  repo: string;
  branch?: string;
  skillsPath?: string;
  token?: string;
}

export interface SkillsMcpConfig {
  repos: RepoConfig[];
  token?: string;
  cacheTtlSeconds?: number;
}

export interface ResolvedRepoConfig {
  owner: string;
  repo: string;
  branch: string;
  skillsPath: string;
  token: string | undefined;
}

export interface ResolvedConfig {
  repos: ResolvedRepoConfig[];
  cacheTtlSeconds: number;
}

function validate(raw: unknown): SkillsMcpConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error("Config must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.repos) || obj.repos.length === 0) {
    throw new Error('Config must have a non-empty "repos" array');
  }
  for (const [i, repo] of obj.repos.entries()) {
    if (!repo || typeof repo !== "object") {
      throw new Error(`repos[${i}] must be an object`);
    }
    const r = repo as Record<string, unknown>;
    if (typeof r.owner !== "string" || !r.owner) {
      throw new Error(`repos[${i}].owner must be a non-empty string`);
    }
    if (typeof r.repo !== "string" || !r.repo) {
      throw new Error(`repos[${i}].repo must be a non-empty string`);
    }
  }
  return obj as unknown as SkillsMcpConfig;
}

const defaultConfigPath = join(homedir(), ".config", "skills-mcp", "config.json");

async function tryReadJson(path: string): Promise<SkillsMcpConfig | null> {
  try {
    const text = await readFile(path, "utf-8");
    return validate(JSON.parse(text));
  } catch {
    return null;
  }
}

export function resolveConfig(raw: SkillsMcpConfig): ResolvedConfig {
  const globalToken = raw.token ?? process.env.GITHUB_TOKEN;
  return {
    cacheTtlSeconds: raw.cacheTtlSeconds ?? 300,
    repos: raw.repos.map((r) => ({
      owner: r.owner,
      repo: r.repo,
      branch: r.branch ?? "main",
      skillsPath: r.skillsPath ?? "skills",
      token: r.token ?? globalToken,
    })),
  };
}

export async function loadConfig(): Promise<ResolvedConfig | null> {
  const raw = await tryReadJson(defaultConfigPath);
  return raw ? resolveConfig(raw) : null;
}

export async function appendRepo(repo: RepoConfig): Promise<ResolvedConfig> {
  await mkdir(join(homedir(), ".config", "skills-mcp"), { recursive: true });
  const existing = await tryReadJson(defaultConfigPath);
  const repos = existing ? [...existing.repos, repo] : [repo];
  const config: SkillsMcpConfig = { repos };
  await writeFile(defaultConfigPath, JSON.stringify(config, null, 2), "utf-8");
  return resolveConfig(config);
}

export async function removeRepo(slug: string): Promise<{ config: ResolvedConfig | null; removed: boolean }> {
  const existing = await tryReadJson(defaultConfigPath);
  if (!existing) return { config: null, removed: false };
  const [owner, repo] = slug.split("/");
  const before = existing.repos.length;
  const repos = existing.repos.filter((r) => !(r.owner === owner && r.repo === repo));
  if (repos.length === before) return { config: resolveConfig(existing), removed: false };
  await writeFile(defaultConfigPath, JSON.stringify({ ...existing, repos }, null, 2), "utf-8");
  const config = repos.length > 0 ? resolveConfig({ ...existing, repos }) : null;
  return { config, removed: true };
}

export async function removeAllRepos(): Promise<void> {
  await writeFile(defaultConfigPath, JSON.stringify({ repos: [] }, null, 2), "utf-8");
}
