import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { listAllSkills, fetchSkill } from "./skillsLoader.js";

export async function startServer(): Promise<void> {
  const config = await loadConfig();

  const server = new McpServer({
    name: "skills-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "listSkills",
    {
      title: "List Skills",
      description:
        "Returns the names of all available skills from the configured GitHub repositories.",
      inputSchema: z.object({}),
    },
    async () => {
      const skills = await listAllSkills(config);
      const text = skills.length > 0
        ? skills.join("\n")
        : "(no skills found — check your config and that the skillsPath directory exists)";
      return { content: [{ type: "text" as const, text }] };
    }
  );

  server.registerTool(
    "getSkill",
    {
      title: "Get Skill",
      description:
        "Returns the markdown content of a named skill. Use listSkills first to see available skill names.",
      inputSchema: z.object({
        name: z.string().describe("The exact skill name as returned by listSkills"),
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
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
