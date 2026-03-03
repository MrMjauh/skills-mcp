import { readFile } from "fs/promises";
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

async function tryReadJson(path: string): Promise<SkillsMcpConfig | null> {
  try {
    const text = await readFile(path, "utf-8");
    return validate(JSON.parse(text));
  } catch {
    return null;
  }
}

export async function loadConfig(): Promise<ResolvedConfig> {
  let raw: SkillsMcpConfig | null = null;

  const envPath = process.env.SKILLS_MCP_CONFIG;
  if (envPath) {
    raw = await tryReadJson(envPath);
    if (!raw) {
      throw new Error(
        `Config file not found or invalid at SKILLS_MCP_CONFIG path: ${envPath}`,
      );
    }
  }

  if (!raw) {
    raw = await tryReadJson(
      join(homedir(), ".config", "skills-mcp", "config.json"),
    );
  }

  if (!raw) {
    raw = await tryReadJson(join(process.cwd(), "config.json"));
  }

  if (!raw) {
    throw new Error(
      "No config file found. Create one at:\n" +
        "  ~/.config/skills-mcp/config.json\n" +
        "  ./config.json\n" +
        "  or set SKILLS_MCP_CONFIG=/path/to/config.json\n\n" +
        "See config.example.json for the expected format.",
    );
  }

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
