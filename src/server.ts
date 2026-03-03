import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { appendRepo, loadConfig, type ResolvedConfig } from "./config";
import {
  fetchSkill,
  findRepoBySlug,
  listSkillsForRepoWithDescriptions,
} from "./skillsLoader";

const NO_CONFIG_ERROR =
  "No skills repository configured. Call the addRepo tool first and ask the user for their GitHub repository URL.";

export async function startServer(): Promise<void> {
  let config: ResolvedConfig | null = await loadConfig();

  const server = new McpServer(
    {
      name: "skills-mcp",
      version: "1.0.0",
    },
    {
      instructions: `This server provides curated expert skill prompts with specialized domain knowledge, architectural patterns, and best-practice guidance.

Workflow:
1. At the start of any technical task, call listRepos then listSkills for each repo to discover available expertise.
2. Present the skill list as a selectable input to the user so they can pick the most relevant skill.
3. Call getSkill to load the chosen skill's full guidance and apply it throughout your response.`,
    },
  );

  server.registerTool(
    "addRepo",
    {
      title: "Add Skills Repository",
      description:
        "Adds a GitHub repository as a skills source. Ask the user for their GitHub repository URL. Can be called multiple times to add multiple repos.",
      inputSchema: z.object({
        url: z
          .string()
          .describe("GitHub repository URL, e.g. https://github.com/owner/repo"),
      }),
    },
    async ({ url }) => {
      const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
      if (!match) {
        return {
          content: [{ type: "text" as const, text: `Invalid GitHub URL: ${url}. Expected format: https://github.com/owner/repo` }],
          isError: true,
        };
      }
      const [, owner, repo] = match;
      config = await appendRepo({ owner, repo });
      return {
        content: [{ type: "text" as const, text: `Added ${owner}/${repo}. You can now call listSkills.` }],
      };
    },
  );

  server.registerTool(
    "listRepos",
    {
      title: "List Repos",
      description: "Lists all configured GitHub skills repositories.",
      inputSchema: z.object({}),
    },
    async () => {
      if (!config) {
        return {
          content: [{ type: "text" as const, text: NO_CONFIG_ERROR }],
          isError: true,
        };
      }
      const lines = config.repos.map(
        (r) => `${r.owner}/${r.repo} (branch: ${r.branch}, path: ${r.skillsPath})`,
      );
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  server.registerTool(
    "listSkills",
    {
      title: "List Skills",
      description:
        "Lists all skills in a specific repository with their path and description. Present the results as a selectable list to the user so they can pick the most relevant skill.",
      inputSchema: z.object({
        repo: z.string().describe('Repository slug in the format "owner/repo"'),
      }),
    },
    async ({ repo: repoSlug }) => {
      if (!config) {
        return {
          content: [{ type: "text" as const, text: NO_CONFIG_ERROR }],
          isError: true,
        };
      }
      const repo = findRepoBySlug(config, repoSlug);
      if (!repo) {
        return {
          content: [{ type: "text" as const, text: `Repo "${repoSlug}" not found. Call listRepos to see configured repositories.` }],
          isError: true,
        };
      }
      const skills = await listSkillsForRepoWithDescriptions(repo, config.cacheTtlSeconds);
      const lines = skills.map(({ name, path, description }) => {
        const desc = description ? ` — ${description}` : "";
        return `${name} (${path})${desc}`;
      });
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  server.registerTool(
    "getSkill",
    {
      title: "Get Skill",
      description:
        "Loads a skill's full prompt, patterns, and guidance. Call this when listSkills shows a relevant skill for the user's task, then apply the skill's recommendations in your response.",
      inputSchema: z.object({
        repo: z.string().describe('Repository slug in the format "owner/repo"'),
        path: z.string().describe("The exact path as returned by listSkills, e.g. skills/commit.md"),
      }),
    },
    async ({ repo: repoSlug, path }) => {
      if (!config) {
        return {
          content: [{ type: "text" as const, text: NO_CONFIG_ERROR }],
          isError: true,
        };
      }
      const repo = findRepoBySlug(config, repoSlug);
      if (!repo) {
        return {
          content: [{ type: "text" as const, text: `Repo "${repoSlug}" not found. Call listRepos to see configured repositories.` }],
          isError: true,
        };
      }
      const result = await fetchSkill(repo, path);
      if ("error" in result) {
        return {
          content: [{ type: "text" as const, text: result.error }],
          isError: true,
        };
      }
      return { content: [{ type: "text" as const, text: result.content }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
