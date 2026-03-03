#!/usr/bin/env node

// src/server.ts
var import_mcp = require("@modelcontextprotocol/sdk/server/mcp.js");
var import_stdio = require("@modelcontextprotocol/sdk/server/stdio.js");
var import_zod = require("zod");

// src/config.ts
var import_promises = require("fs/promises");
var import_os = require("os");
var import_path = require("path");
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
async function tryReadJson(path) {
  try {
    const text = await (0, import_promises.readFile)(path, "utf-8");
    return validate(JSON.parse(text));
  } catch {
    return null;
  }
}
async function loadConfig() {
  let raw = null;
  const envPath = process.env.SKILLS_MCP_CONFIG;
  if (envPath) {
    raw = await tryReadJson(envPath);
    if (!raw) {
      throw new Error(
        `Config file not found or invalid at SKILLS_MCP_CONFIG path: ${envPath}`
      );
    }
  }
  if (!raw) {
    raw = await tryReadJson(
      (0, import_path.join)((0, import_os.homedir)(), ".config", "skills-mcp", "config.json")
    );
  }
  if (!raw) {
    raw = await tryReadJson((0, import_path.join)(process.cwd(), "config.json"));
  }
  if (!raw) {
    throw new Error(
      "No config file found. Create one at:\n  ~/.config/skills-mcp/config.json\n  ./config.json\n  or set SKILLS_MCP_CONFIG=/path/to/config.json\n\nSee config.example.json for the expected format."
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
      token: r.token ?? globalToken
    }))
  };
}

// src/skillsLoader.ts
var import_request_error = require("@octokit/request-error");

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
var import_rest = require("@octokit/rest");
function createOctokit(token) {
  return new import_rest.Octokit({ auth: token });
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
  let names;
  if (layout === "flat") {
    names = items.filter(
      (i) => i.type === "file" && (i.name.endsWith(".md") || i.name.endsWith(".ts"))
    ).map((i) => i.name.slice(0, -3)).sort();
  } else {
    names = items.filter((i) => i.type === "dir").map((i) => i.name).sort();
  }
  cache.set(listKey, names);
  return names;
}
function extractDescription(content) {
  const fmMatch = content.match(/(?:^|\n)---\n([\s\S]*?)\n---/);
  if (!fmMatch)
    return null;
  const descMatch = fmMatch[1].match(/^description:\s*(.+)$/m);
  return descMatch ? descMatch[1].trim() : null;
}
async function listAllSkillsWithDescriptions(config) {
  const names = await listAllSkills(config);
  return Promise.all(
    names.map(async (name) => {
      const cached = cache.get(`skill:${name}`, config.cacheTtlSeconds);
      const content = cached ? cached : await fetchSkill(config, name).then(
        (r) => "error" in r ? null : r.content
      );
      return { name, description: content ? extractDescription(content) : null };
    })
  );
}
async function listAllSkills(config) {
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  for (const repo of config.repos) {
    try {
      const names = await listSkillsForRepo(repo, config.cacheTtlSeconds);
      for (const name of names) {
        if (seen.has(name)) {
          log(
            "warn",
            `Skill name collision: "${name}" already seen (${repo.owner}/${repo.repo} ignored)`
          );
        } else {
          seen.add(name);
          result.push(name);
        }
      }
    } catch (err) {
      log(
        "error",
        `Failed to list skills from ${repo.owner}/${repo.repo}: ${formatError(err)}`
      );
    }
  }
  return result.sort();
}
async function findSkillRepo(config, name) {
  for (const repo of config.repos) {
    try {
      const names = await listSkillsForRepo(repo, config.cacheTtlSeconds);
      if (names.includes(name))
        return repo;
    } catch {
    }
  }
  return null;
}
async function fetchSkill(config, rawName) {
  const name = sanitizeName(rawName);
  if (!name) {
    return {
      error: `Invalid skill name: "${rawName}". Names must not be empty or contain path characters.`
    };
  }
  const cacheKey = `skill:${name}`;
  const cached = cache.get(cacheKey, config.cacheTtlSeconds);
  if (cached) {
    log("info", `Cache hit for skill "${name}"`);
    return { content: cached };
  }
  const repo = await findSkillRepo(config, name);
  if (!repo) {
    return {
      error: `Skill not found: "${name}". Run listSkills to see available skills.`
    };
  }
  const repoKey = `skill:${repo.owner}/${repo.repo}:${name}`;
  const repoCache = cache.get(repoKey, config.cacheTtlSeconds);
  if (repoCache)
    return { content: repoCache };
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
        if (err instanceof import_request_error.RequestError && err.status === 404) {
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
    cache.set(repoKey, content);
    return { content };
  } catch (err) {
    return { error: formatError(err) };
  }
}
function formatError(err) {
  if (err instanceof import_request_error.RequestError) {
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
async function startServer() {
  const config = await loadConfig();
  const server = new import_mcp.McpServer(
    {
      name: "skills-mcp",
      version: "1.0.0"
    },
    {
      instructions: `This server provides curated expert skill prompts with specialized domain knowledge, architectural patterns, and best-practice guidance.

Workflow:
1. At the start of any technical task, call listSkills to discover available expertise.
2. If a skill matches the user's domain or task, call getSkill to load its full guidance.
3. Apply the skill's patterns and recommendations throughout your response.`
    }
  );
  server.registerTool(
    "listSkills",
    {
      title: "List Skills",
      description: "Lists all available skills with descriptions when cached. Call this at the start of a task to discover relevant domain expertise before responding.",
      inputSchema: import_zod.z.object({})
    },
    async () => {
      const skills = await listAllSkillsWithDescriptions(config);
      const lines = skills.map(
        ({ name, description }) => description ? `${name} \u2014 ${description}` : name
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
  server.registerTool(
    "getSkill",
    {
      title: "Get Skill",
      description: "Loads a skill's full prompt, patterns, and guidance. Call this when listSkills shows a relevant skill for the user's task, then apply the skill's recommendations in your response.",
      inputSchema: import_zod.z.object({
        name: import_zod.z.string().describe("The exact skill name as returned by listSkills")
      })
    },
    async ({ name }) => {
      const result = await fetchSkill(config, name);
      if ("error" in result) {
        return {
          content: [{ type: "text", text: result.error }],
          isError: true
        };
      }
      return { content: [{ type: "text", text: result.content }] };
    }
  );
  const transport = new import_stdio.StdioServerTransport();
  await server.connect(transport);
}

// src/index.ts
startServer().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[skills-mcp] Fatal error: ${message}
`);
  process.exit(1);
});
