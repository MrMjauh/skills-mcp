import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, resolveConfig, writeConfig, type ResolvedConfig } from "./config";
import { fetchSkill, listAllSkillsWithDescriptions } from "./skillsLoader";

const NO_CONFIG_ERROR =
  "No skills repository configured. Call the configureSkills tool first to set up your GitHub skills repo.";

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
1. At the start of any technical task, call listSkills to discover available expertise.
2. If a skill matches the user's domain or task, call getSkill to load its full guidance.
3. Apply the skill's patterns and recommendations throughout your response.`,
    },
  );

  server.registerTool(
    "configureSkills",
    {
      title: "Configure Skills Repository",
      description:
        "Sets up the GitHub repository to load skills from. Call this when no skills repository is configured yet. Ask the user for their GitHub repository URL.",
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
      await writeConfig({ owner, repo });
      config = resolveConfig({ repos: [{ owner, repo }] });
      return {
        content: [{ type: "text" as const, text: `Skills repository configured: ${owner}/${repo}. You can now call listSkills.` }],
      };
    },
  );

  server.registerTool(
    "listSkills",
    {
      title: "List Skills",
      description:
        "Lists all available skills with descriptions when cached. Call this at the start of a task to discover relevant domain expertise before responding.",
      inputSchema: z.object({}),
    },
    async () => {
      if (!config) {
        return {
          content: [{ type: "text" as const, text: NO_CONFIG_ERROR }],
          isError: true,
        };
      }
      const skills = await listAllSkillsWithDescriptions(config);
      const lines = skills.map(({ name, description }) =>
        description ? `${name} — ${description}` : name,
      );
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
        name: z
          .string()
          .describe("The exact skill name as returned by listSkills"),
      }),
    },
    async ({ name }) => {
      if (!config) {
        return {
          content: [{ type: "text" as const, text: NO_CONFIG_ERROR }],
          isError: true,
        };
      }
      const result = await fetchSkill(config, name);
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
