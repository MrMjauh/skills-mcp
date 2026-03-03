# skills-mcp

An MCP server that exposes GitHub-hosted skill files as tools, making them available to Claude Code and other MCP clients.

## How it works

Skills are markdown (or TypeScript) files stored in a GitHub repository. This server reads them via the GitHub API and surfaces MCP tools for listing and fetching skills.

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

## Setup

```sh
claude mcp add skills -- npx github:MrMjauh/skills-mcp
```

Or manually in your MCP config:

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

## First-time configuration

When no repository is configured, the server starts but `listSkills` and `getSkill` will prompt you to configure first. Ask Claude to add a repo:

> "Add my skills repo: https://github.com/your-org/your-skills-repo"

Claude will call `addRepo` with the URL and save it to `~/.config/skills-mcp/config.json`. You can call `addRepo` multiple times to add more repos.

## Tools

| Tool | Input | Description |
|------|-------|-------------|
| `addRepo` | `url` | Add a GitHub repo as a skills source (by URL). |
| `removeRepo` | `repo` (slug `owner/repo`) | Remove a specific repo from the configuration. |
| `removeAllRepos` | — | Remove all configured repos. |
| `listRepos` | — | List all configured repos. |
| `listSkills` | — | List all skills across all repos, grouped by repo. Each section header shows the slug to use with `getSkill`. |
| `getSkill` | `repo` (slug), `path` | Load a skill's full prompt and guidance by path (as returned by `listSkills`). |

## Skill repository layouts

| Layout | Structure | Detection |
|--------|-----------|-----------|
| Flat   | `skills/name.md` | top-level contains only files |
| Nested | `skills/name/` (dir with `.md`/`.ts` files) | top-level contains directories |

When multiple repos are configured, `listSkills` shows all of them grouped by repo.

## GitHub token

A token is required for private repos and recommended for rate-limit headroom. Set it via the `GITHUB_TOKEN` environment variable.
