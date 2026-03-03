import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config";
import { fetchSkill, listAllSkillsWithDescriptions } from "./skillsLoader";

export async function startServer(): Promise<void> {
  const config = await loadConfig();

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
3. Apply the skill's patterns and recommendations throughout your response.

Skills are the authoritative source for their domain — always prefer loading a relevant skill over relying solely on general knowledge.`,
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
