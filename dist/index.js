#!/usr/bin/env node

// src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// src/config.ts
import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
function validate(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("Config must be a JSON object");
  }
  const obj = raw;
  if (!Array.isArray(obj.repos) || obj.repos.length === 0) {
    throw new Error('Config must have a non-empty "repos" array');
  }
  for (const [i, repo] of obj.repos.entries()) {
    if (!repo || typeof repo !== "object") {
      throw new Error(`repos[${i}] must be an object`);
    }
    const r = repo;
    if (typeof r.owner !== "string" || !r.owner) {
      throw new Error(`repos[${i}].owner must be a non-empty string`);
    }
    if (typeof r.repo !== "string" || !r.repo) {
      throw new Error(`repos[${i}].repo must be a non-empty string`);
    }
  }
  return obj;
}
var defaultConfigPath = join(homedir(), ".config", "skills-mcp", "config.json");
async function tryReadJson(path) {
  try {
    const text = await readFile(path, "utf-8");
    return validate(JSON.parse(text));
  } catch {
    return null;
  }
}
function resolveConfig(raw) {
  const globalToken = raw.token ?? process.env.GITHUB_TOKEN;
  return {
    cacheTtlSeconds: raw.cacheTtlSeconds ?? 300,
    repos: raw.repos.map((r) => ({
      owner: r.owner,
      repo: r.repo,
      branch: r.branch ?? "main",
      skillsPath: r.skillsPath ?? "skills",
      token: r.token ?? globalToken
    }))
  };
}
async function loadConfig() {
  const raw = await tryReadJson(defaultConfigPath);
  return raw ? resolveConfig(raw) : null;
}
async function appendRepo(repo) {
  await mkdir(join(homedir(), ".config", "skills-mcp"), { recursive: true });
  const existing = await tryReadJson(defaultConfigPath);
  const repos = existing ? [...existing.repos, repo] : [repo];
  const config = { repos };
  await writeFile(defaultConfigPath, JSON.stringify(config, null, 2), "utf-8");
  return resolveConfig(config);
}

// src/skillsLoader.ts
import { RequestError } from "@octokit/request-error";

// src/cache.ts
var SkillsCache = class {
  store = /* @__PURE__ */ new Map();
  get(key, ttlSeconds) {
    const entry = this.store.get(key);
    if (!entry)
      return null;
    if (Date.now() - entry.fetchedAt > ttlSeconds * 1e3) {
      this.store.delete(key);
      return null;
    }
    return entry.data;
  }
  set(key, data) {
    this.store.set(key, { data, fetchedAt: Date.now() });
  }
  // Layout cache has no TTL — persists for the session
  getLayout(key) {
    const entry = this.store.get(key);
    return entry?.data ?? null;
  }
  setLayout(key, layout) {
    this.store.set(key, { data: layout, fetchedAt: Date.now() });
  }
};
var cache = new SkillsCache();

// src/github.ts
import { Octokit } from "@octokit/rest";
function createOctokit(token) {
  return new Octokit({ auth: token });
}
async function listDirectory(octokit, owner, repo, branch, path) {
  const { data } = await octokit.rest.repos.getContent({
    owner,
    repo,
    ref: branch,
    path
  });
  if (!Array.isArray(data)) {
    throw new Error(`Expected a directory at "${path}" but got a file`);
  }
  return data;
}
async function getFileContent(octokit, owner, repo, branch, path) {
  const { data } = await octokit.rest.repos.getContent({
    owner,
    repo,
    ref: branch,
    path
  });
  if (Array.isArray(data)) {
    throw new Error(`Expected a file at "${path}" but got a directory`);
  }
  const file = data;
  if (file.type !== "file") {
    throw new Error(`Unexpected content type "${file.type}" at "${path}"`);
  }
  if (file.size > 1e6) {
    throw new Error(
      `File "${path}" is ${file.size} bytes (>1 MB). Large files are not supported via the Contents API.`
    );
  }
  if (!file.content) {
    throw new Error(`File "${path}" has no content`);
  }
  const clean = file.content.replace(/\n/g, "");
  return Buffer.from(clean, "base64").toString("utf-8");
}

// src/skillsLoader.ts
function log(level, message) {
  process.stderr.write(`[skills-mcp] ${level.toUpperCase()}: ${message}
`);
}
function sanitizeName(name) {
  const trimmed = name.trim();
  if (!trimmed)
    return null;
  if (trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\")) {
    return null;
  }
  return trimmed;
}
async function detectLayout(repo) {
  const layoutKey = `layout:${repo.owner}/${repo.repo}`;
  const cached = cache.getLayout(layoutKey);
  if (cached)
    return cached;
  const octokit = createOctokit(repo.token);
  const items = await listDirectory(
    octokit,
    repo.owner,
    repo.repo,
    repo.branch,
    repo.skillsPath
  );
  const hasDir = items.some((i) => i.type === "dir");
  const layout = hasDir ? "nested" : "flat";
  log("info", `Detected layout for ${repo.owner}/${repo.repo}: ${layout}`);
  cache.setLayout(layoutKey, layout);
  return layout;
}
async function listSkillsForRepo(repo, ttl) {
  const listKey = `list:${repo.owner}/${repo.repo}`;
  const cached = cache.get(listKey, ttl);
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
    repo.skillsPath
  );
  const layout = await detectLayout(repo);
  let skills;
  if (layout === "flat") {
    skills = items.filter(
      (i) => i.type === "file" && (i.name.endsWith(".md") || i.name.endsWith(".ts"))
    ).map((i) => ({ name: i.name.slice(0, -3), path: i.path })).sort((a, b) => a.name.localeCompare(b.name));
  } else {
    skills = items.filter((i) => i.type === "dir").map((i) => ({ name: i.name, path: i.path })).sort((a, b) => a.name.localeCompare(b.name));
  }
  cache.set(listKey, skills);
  return skills;
}
function extractDescription(content) {
  const fmMatch = content.match(/(?:^|\n)---\n([\s\S]*?)\n---/);
  if (!fmMatch)
    return null;
  const descMatch = fmMatch[1].match(/^description:\s*(.+)$/m);
  return descMatch ? descMatch[1].trim() : null;
}
async function listSkillsForRepoWithDescriptions(repo, ttl) {
  const skills = await listSkillsForRepo(repo, ttl);
  return Promise.all(
    skills.map(async ({ name, path }) => {
      const cacheKey = `skill:${repo.owner}/${repo.repo}:${name}`;
      const cached = cache.get(cacheKey, ttl);
      const content = cached ? cached : await fetchSkillFromRepo(repo, name).then(
        (r) => "error" in r ? null : r.content
      );
      return { name, path, description: content ? extractDescription(content) : null };
    })
  );
}
function findRepoBySlug(config, slug) {
  return config.repos.find((r) => `${r.owner}/${r.repo}` === slug);
}
async function fetchSkillFromRepo(repo, name) {
  const cacheKey = `skill:${repo.owner}/${repo.repo}:${name}`;
  const cached = cache.get(cacheKey, 300);
  if (cached)
    return { content: cached };
  try {
    const layout = await detectLayout(repo);
    const octokit = createOctokit(repo.token);
    let content;
    if (layout === "flat") {
      try {
        content = await getFileContent(
          octokit,
          repo.owner,
          repo.repo,
          repo.branch,
          `${repo.skillsPath}/${name}.md`
        );
      } catch (err) {
        if (err instanceof RequestError && err.status === 404) {
          content = await getFileContent(
            octokit,
            repo.owner,
            repo.repo,
            repo.branch,
            `${repo.skillsPath}/${name}.ts`
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
        `${repo.skillsPath}/${name}`
      );
      const mdFiles = files.filter(
        (f) => f.type === "file" && (f.name.endsWith(".md") || f.name.endsWith(".ts"))
      ).sort((a, b) => a.name.localeCompare(b.name));
      if (mdFiles.length === 0) {
        return {
          error: `Skill "${name}" exists but has no markdown or TypeScript files.`
        };
      }
      const parts = await Promise.all(
        mdFiles.map(async (f) => {
          const text = await getFileContent(
            octokit,
            repo.owner,
            repo.repo,
            repo.branch,
            f.path
          );
          return `## ${f.name}

${text}`;
        })
      );
      content = parts.join("\n\n---\n\n");
    }
    cache.set(cacheKey, content);
    return { content };
  } catch (err) {
    return { error: formatError(err) };
  }
}
async function fetchSkill(repo, rawName) {
  const name = sanitizeName(rawName);
  if (!name) {
    return {
      error: `Invalid skill name: "${rawName}". Names must not be empty or contain path characters.`
    };
  }
  return fetchSkillFromRepo(repo, name);
}
function formatError(err) {
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
      const resetTime = reset ? new Date(Number(reset) * 1e3).toISOString() : "unknown";
      return `GitHub rate limit exceeded. Resets at ${resetTime}. Add a token to increase your limit.`;
    }
    return `GitHub API error (${status}): ${err.message}`;
  }
  if (err instanceof Error)
    return err.message;
  return String(err);
}

// src/server.ts
var NO_CONFIG_ERROR = "No skills repository configured. Call the addRepo tool first and ask the user for their GitHub repository URL.";
async function startServer() {
  let config = await loadConfig();
  const server = new McpServer(
    {
      name: "skills-mcp",
      version: "1.0.0"
    },
    {
      instructions: `This server provides curated expert skill prompts with specialized domain knowledge, architectural patterns, and best-practice guidance.

Workflow:
1. At the start of any technical task, call listRepos then listSkills for each repo to discover available expertise.
2. Present the skill list as a selectable input to the user so they can pick the most relevant skill.
3. Call getSkill to load the chosen skill's full guidance and apply it throughout your response.`
    }
  );
  server.registerTool(
    "addRepo",
    {
      title: "Add Skills Repository",
      description: "Adds a GitHub repository as a skills source. Ask the user for their GitHub repository URL. Can be called multiple times to add multiple repos.",
      inputSchema: z.object({
        url: z.string().describe("GitHub repository URL, e.g. https://github.com/owner/repo")
      })
    },
    async ({ url }) => {
      const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
      if (!match) {
        return {
          content: [{ type: "text", text: `Invalid GitHub URL: ${url}. Expected format: https://github.com/owner/repo` }],
          isError: true
        };
      }
      const [, owner, repo] = match;
      config = await appendRepo({ owner, repo });
      return {
        content: [{ type: "text", text: `Added ${owner}/${repo}. You can now call listSkills.` }]
      };
    }
  );
  server.registerTool(
    "listRepos",
    {
      title: "List Repos",
      description: "Lists all configured GitHub skills repositories.",
      inputSchema: z.object({})
    },
    async () => {
      if (!config) {
        return {
          content: [{ type: "text", text: NO_CONFIG_ERROR }],
          isError: true
        };
      }
      const lines = config.repos.map(
        (r) => `${r.owner}/${r.repo} (branch: ${r.branch}, path: ${r.skillsPath})`
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
  server.registerTool(
    "listSkills",
    {
      title: "List Skills",
      description: "Lists all skills in a specific repository with their path and description. Present the results as a selectable list to the user so they can pick the most relevant skill.",
      inputSchema: z.object({
        repo: z.string().describe('Repository slug in the format "owner/repo"')
      })
    },
    async ({ repo: repoSlug }) => {
      if (!config) {
        return {
          content: [{ type: "text", text: NO_CONFIG_ERROR }],
          isError: true
        };
      }
      const repo = findRepoBySlug(config, repoSlug);
      if (!repo) {
        return {
          content: [{ type: "text", text: `Repo "${repoSlug}" not found. Call listRepos to see configured repositories.` }],
          isError: true
        };
      }
      const skills = await listSkillsForRepoWithDescriptions(repo, config.cacheTtlSeconds);
      const lines = skills.map(({ name, path, description }) => {
        const desc = description ? ` \u2014 ${description}` : "";
        return `${name} (${path})${desc}`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
  server.registerTool(
    "getSkill",
    {
      title: "Get Skill",
      description: "Loads a skill's full prompt, patterns, and guidance. Call this when listSkills shows a relevant skill for the user's task, then apply the skill's recommendations in your response.",
      inputSchema: z.object({
        repo: z.string().describe('Repository slug in the format "owner/repo"'),
        name: z.string().describe("The exact skill name as returned by listSkills")
      })
    },
    async ({ repo: repoSlug, name }) => {
      if (!config) {
        return {
          content: [{ type: "text", text: NO_CONFIG_ERROR }],
          isError: true
        };
      }
      const repo = findRepoBySlug(config, repoSlug);
      if (!repo) {
        return {
          content: [{ type: "text", text: `Repo "${repoSlug}" not found. Call listRepos to see configured repositories.` }],
          isError: true
        };
      }
      const result = await fetchSkill(repo, name);
      if ("error" in result) {
        return {
          content: [{ type: "text", text: result.error }],
          isError: true
        };
      }
      return { content: [{ type: "text", text: result.content }] };
    }
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// src/index.ts
startServer().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[skills-mcp] Fatal error: ${message}
`);
  process.exit(1);
});
