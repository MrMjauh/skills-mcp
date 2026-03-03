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

| Tool | Description |
|------|-------------|
| `addRepo` | Add a GitHub repo as a skills source (by URL). Ask the user for their GitHub URL. |
| `listRepos` | List all configured repos. |
| `listSkills` | List available skills with descriptions. Results are presented as a selectable list. |
| `getSkill` | Load a skill's full prompt and guidance by name. |

## Skill repository layouts

| Layout | Structure | Detection |
|--------|-----------|-----------|
| Flat   | `skills/name.md` | top-level contains only files |
| Nested | `skills/name/` (dir with `.md`/`.ts` files) | top-level contains directories |

When multiple repos are configured, skills from later repos are skipped on name collision (first repo wins).

## GitHub token

A token is required for private repos and recommended for rate-limit headroom. Set it via the `GITHUB_TOKEN` environment variable.
