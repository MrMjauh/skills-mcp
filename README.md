# skills-mcp

An MCP server that exposes GitHub-hosted skill files as tools, making them available to Claude Code and other MCP clients.

## How it works

Skills are markdown (or TypeScript) files stored in a GitHub repository. This server reads them via the GitHub API and surfaces two MCP tools: `listSkills` and `getSkill`.

```
  Claude Code / MCP client
         |
         | MCP (stdio)
         v
    skills-mcp server
         |
         | GitHub API (Octokit)
         v
  GitHub repo(s)  ──>  skills/
                         ├── commit.md         (flat layout)
                         ├── review-pr.md
                         └── deploy/           (nested layout)
                               ├── prompt.md
                               └── steps.md
```

### Request flow

```
client: listSkills
  └─> fetch repo directory listing
  └─> detect layout (flat files vs nested folders)
  └─> return skill names  ──> cached for cacheTtlSeconds

client: getSkill("commit")
  └─> find which repo owns "commit"
  └─> fetch file content from GitHub
  └─> return markdown text  ──> cached
```

### Layouts

| Layout | Structure | Detection |
|--------|-----------|-----------|
| Flat   | `skills/name.md` | top-level contains only files |
| Nested | `skills/name/` (dir with `.md`/`.ts` files) | top-level contains directories |

Multiple repos can be configured. Skills from later repos are skipped on name collision (first repo wins).

## Config

Config is loaded from the first found location:

1. `$SKILLS_MCP_CONFIG` (env var path)
2. `~/.config/skills-mcp/config.json`
3. `./config.json`

```json
{
  "repos": [
    {
      "owner": "your-org",
      "repo": "your-skills-repo",
      "branch": "main",
      "skillsPath": "skills"
    }
  ],
  "token": "github_pat_...",
  "cacheTtlSeconds": 300
}
```

A GitHub token is required for private repos and recommended for rate-limit headroom. Set it globally via `GITHUB_TOKEN` or per-repo in the config.

## Setup

Add to your Claude Code MCP config:

```json
{
  "mcpServers": {
    "skills": {
      "command": "npx",
      "args": ["github:MrMjauh/skills-mcp"]
    }
  }
}
```

Or clone and build locally:

```sh
git clone https://github.com/MrMjauh/skills-mcp
cd skills-mcp
npm install
npm run build
```

```json
{
  "mcpServers": {
    "skills": {
      "command": "node",
      "args": ["/path/to/skills-mcp/dist/index.js"]
    }
  }
}
```
