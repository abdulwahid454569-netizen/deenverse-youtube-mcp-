
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

function createServer() {
  const server = new McpServer({
    name: "deenverse-youtube-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "hello",
    {
      description: "Test DeenVerse MCP server connection",
      inputSchema: z.object({
        name: z.string().optional(),
      }),
    },
    async ({ name }) => ({
      content: [
        {
          type: "text",
          text: `Hello ${name ?? "User"}! DeenVerse MCP server is working.`,
        },
      ],
    }),
  );

  return server;
}

export default {
  fetch(request, env, ctx) {
    return createMcpHandler(createServer)(request, env, ctx);
  },
};
