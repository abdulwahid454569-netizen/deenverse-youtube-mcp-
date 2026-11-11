
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

interface Env {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REFRESH_TOKEN: string;
}

async function getAccessToken(env: Env): Promise<string> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });

  const data: any = await response.json();

  if (!response.ok) {
    throw new Error(data.error_description || data.error || "Google authentication failed");
  }

  return data.access_token;
}

async function youtube(
  env: Env,
  endpoint: string,
  params: Record<string, string> = {},
  method = "GET",
  body?: unknown
) {
  const token = await getAccessToken(env);
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);

  Object.entries(params).forEach(([key, value]) =>
    url.searchParams.set(key, value)
  );

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data: any = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.message || "YouTube API request failed");
  }

  return data;
}

function result(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function createServer(env: Env) {
  const server = new McpServer({
    name: "deenverse-youtube-mcp",
    version: "2.0.0",
  });

  // 1. Channel information
  server.registerTool(
    "get_channel",
    {
      description: "Get the authenticated YouTube channel information.",
      inputSchema: z.object({}),
    },
    async () => result(
      await youtube(env, "channels", {
        part: "snippet,statistics,contentDetails",
        mine: "true",
      })
    )
  );

  // 2. List channel videos
  server.registerTool(
    "list_videos",
    {
      description: "List videos uploaded to the authenticated YouTube channel.",
      inputSchema: z.object({
        maxResults: z.number().int().min(1).max(50).default(10),
      }),
    },
    async ({ maxResults }) => {
      const channel = await youtube(env, "channels", {
        part: "contentDetails",
        mine: "true",
      });

      const playlistId =
        channel.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;

      if (!playlistId) throw new Error("Channel uploads playlist not found");

      return result(await youtube(env, "playlistItems", {
        part: "snippet,contentDetails",
        playlistId,
        maxResults: String(maxResults),
      }));
    }
  );

  // 3. Search YouTube videos
  server.registerTool(
    "search_videos",
    {
      description: "Search public YouTube videos by keyword.",
      inputSchema: z.object({
        query: z.string(),
        maxResults: z.number().int().min(1).max(50).default(10),
      }),
    },
    async ({ query, maxResults }) => result(
      await youtube(env, "search", {
        part: "snippet",
        q: query,
        type: "video",
        maxResults: String(maxResults),
      })
    )
  );

  // 4. Update video title, description and tags
  server.registerTool(
    "update_video",
    {
      description: "Update the title, description or tags of your YouTube video.",
      inputSchema: z.object({
        videoId: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
      }),
    },
    async ({ videoId, title, description, tags }) => {
      if (!title && !description && !tags) {
        throw new Error("Provide at least one field to update");
      }

      const existing = await youtube(env, "videos", {
        part: "snippet,status",
        id: videoId,
      });

      if (!existing.items?.length) throw new Error("Video not found");

      const video = existing.items[0];

      const snippet = {
        ...video.snippet,
        title: title ?? video.snippet.title,
        description: description ?? video.snippet.description,
        tags: tags ?? video.snippet.tags,
        categoryId: video.snippet.categoryId,
      };

      return result(await youtube(
        env,
        "videos",
        { part: "snippet,status" },
        "PUT",
        {
          id: videoId,
          snippet,
          status: video.status,
        }
      ));
    }
  );

  // 5. Read comments
  server.registerTool(
    "get_comments",
    {
      description: "Read comments on a YouTube video.",
      inputSchema: z.object({
        videoId: z.string(),
        maxResults: z.number().int().min(1).max(100).default(20),
      }),
    },
    async ({ videoId, maxResults }) => result(
      await youtube(env, "commentThreads", {
        part: "snippet,replies",
        videoId,
        maxResults: String(maxResults),
        order: "time",
      })
    )
  );

  // 6. Reply to a comment
  server.registerTool(
    "reply_to_comment",
    {
      description: "Post a reply to a YouTube comment.",
      inputSchema: z.object({
        commentId: z.string(),
        text: z.string().min(1).max(10000),
      }),
    },
    async ({ commentId, text }) => result(
      await youtube(
        env,
        "comments",
        { part: "snippet" },
        "POST",
        {
          snippet: {
            parentId: commentId,
            textOriginal: text,
          },
        }
      )
    )
  );

  // 7. List playlists
  server.registerTool(
    "list_playlists",
    {
      description: "List playlists belonging to your YouTube channel.",
      inputSchema: z.object({
        maxResults: z.number().int().min(1).max(50).default(20),
      }),
    },
    async ({ maxResults }) => result(
      await youtube(env, "playlists", {
        part: "snippet,contentDetails,status",
        mine: "true",
        maxResults: String(maxResults),
      })
    )
  );

  // 8. Create a playlist
  server.registerTool(
    "create_playlist",
    {
      description: "Create a playlist on your YouTube channel.",
      inputSchema: z.object({
        title: z.string().min(1).max(150),
        description: z.string().max(5000).default(""),
        privacy: z.enum(["private", "public", "unlisted"]).default("private"),
      }),
    },
    async ({ title, description, privacy }) => result(
      await youtube(
        env,
        "playlists",
        { part: "snippet,status" },
        "POST",
        {
          snippet: { title, description },
          status: { privacyStatus: privacy },
        }
      )
    )
  );

  return server;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return createMcpHandler(createServer(env))(request, env, ctx);
  },
};
