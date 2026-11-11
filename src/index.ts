
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

interface Env {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REFRESH_TOKEN: string;
}

// ------------------------------------
// GOOGLE OAUTH ACCESS TOKEN
// ------------------------------------

async function getAccessToken(env: Env): Promise<string> {
  if (
    !env.GOOGLE_CLIENT_ID ||
    !env.GOOGLE_CLIENT_SECRET ||
    !env.GOOGLE_REFRESH_TOKEN
  ) {
    throw new Error("Google OAuth secrets are missing in Cloudflare.");
  }

  const response = await fetch(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        refresh_token: env.GOOGLE_REFRESH_TOKEN,
        grant_type: "refresh_token",
      }),
    }
  );

  const data: any = await response.json();

  if (!response.ok) {
    throw new Error(
      `Google OAuth Error: ${
        data.error_description || data.error || response.status
      }`
    );
  }

  if (!data.access_token) {
    throw new Error("Google did not return an access token.");
  }

  return data.access_token;
}

// ------------------------------------
// YOUTUBE API HELPER
// ------------------------------------

async function youtube(
  env: Env,
  endpoint: string,
  params: Record<string, string> = {},
  method = "GET",
  body?: unknown
): Promise<any> {
  const token = await getAccessToken(env);

  const url = new URL(
    `https://www.googleapis.com/youtube/v3/${endpoint}`
  );

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const data: any = await response.json();

  if (!response.ok) {
    throw new Error(
      `YouTube API Error (${response.status}): ${
        data.error?.message || "Request failed"
      }`
    );
  }

  return data;
}

// ------------------------------------
// MCP TOOL RESPONSE
// ------------------------------------

function result(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

// ------------------------------------
// CREATE MCP SERVER
// ------------------------------------

function createServer(env: Env) {
  const server = new McpServer({
    name: "deenverse-youtube-mcp",
    version: "2.0.0",
  });

  // 1. GET CHANNEL INFORMATION

  server.registerTool(
    "get_channel",
    {
      description:
        "Get information, statistics and details of the authenticated YouTube channel.",
      inputSchema: z.object({}),
    },
    async () => {
      const data = await youtube(env, "channels", {
        part: "snippet,statistics,contentDetails",
        mine: "true",
      });

      return result(data);
    }
  );

  // 2. LIST CHANNEL VIDEOS

  server.registerTool(
    "list_videos",
    {
      description:
        "List uploaded videos from the authenticated YouTube channel.",
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

      if (!playlistId) {
        throw new Error("Channel uploads playlist not found.");
      }

      const data = await youtube(env, "playlistItems", {
        part: "snippet,contentDetails",
        playlistId,
        maxResults: String(maxResults),
      });

      return result(data);
    }
  );

  // 3. SEARCH YOUTUBE VIDEOS

  server.registerTool(
    "search_videos",
    {
      description: "Search public YouTube videos by keyword.",
      inputSchema: z.object({
        query: z.string().min(1),
        maxResults: z.number().int().min(1).max(50).default(10),
      }),
    },
    async ({ query, maxResults }) => {
      const data = await youtube(env, "search", {
        part: "snippet",
        q: query,
        type: "video",
        maxResults: String(maxResults),
      });

      return result(data);
    }
  );

  // 4. UPDATE VIDEO DETAILS

  server.registerTool(
    "update_video",
    {
      description:
        "Update a YouTube video's title, description or tags.",
      inputSchema: z.object({
        videoId: z.string().min(1),
        title: z.string().optional(),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
      }),
    },
    async ({ videoId, title, description, tags }) => {
      if (
        title === undefined &&
        description === undefined &&
        tags === undefined
      ) {
        throw new Error("Provide at least one field to update.");
      }

      const existing = await youtube(env, "videos", {
        part: "snippet,status",
        id: videoId,
      });

      if (!existing.items?.length) {
        throw new Error("Video not found.");
      }

      const video = existing.items[0];

      const snippet = {
        ...video.snippet,
        title: title ?? video.snippet.title,
        description: description ?? video.snippet.description,
        tags: tags ?? video.snippet.tags,
      };

      const data = await youtube(
        env,
        "videos",
        { part: "snippet,status" },
        "PUT",
        {
          id: videoId,
          snippet,
          status: video.status,
        }
      );

      return result(data);
    }
  );

  // 5. READ VIDEO COMMENTS

  server.registerTool(
    "get_comments",
    {
      description: "Read comments on a YouTube video.",
      inputSchema: z.object({
        videoId: z.string().min(1),
        maxResults: z.number().int().min(1).max(100).default(20),
      }),
    },
    async ({ videoId, maxResults }) => {
      const data = await youtube(env, "commentThreads", {
        part: "snippet,replies",
        videoId,
        maxResults: String(maxResults),
        order: "time",
      });

      return result(data);
    }
  );

  // 6. REPLY TO COMMENTS

  server.registerTool(
    "reply_to_comment",
    {
      description: "Post a reply to a YouTube comment.",
      inputSchema: z.object({
        commentId: z.string().min(1),
        text: z.string().min(1).max(10000),
      }),
    },
    async ({ commentId, text }) => {
      const data = await youtube(
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
      );

      return result(data);
    }
  );

  // 7. LIST PLAYLISTS

  server.registerTool(
    "list_playlists",
    {
      description: "List playlists belonging to your YouTube channel.",
      inputSchema: z.object({
        maxResults: z.number().int().min(1).max(50).default(20),
      }),
    },
    async ({ maxResults }) => {
      const data = await youtube(env, "playlists", {
        part: "snippet,contentDetails,status",
        mine: "true",
        maxResults: String(maxResults),
      });

      return result(data);
    }
  );

  // 8. CREATE PLAYLIST

  server.registerTool(
    "create_playlist",
    {
      description: "Create a playlist on your YouTube channel.",
      inputSchema: z.object({
        title: z.string().min(1).max(150),
        description: z.string().max(5000).default(""),
        privacy: z
          .enum(["private", "public", "unlisted"])
          .default("private"),
      }),
    },
    async ({ title, description, privacy }) => {
      const data = await youtube(
        env,
        "playlists",
        { part: "snippet,status" },
        "POST",
        {
          snippet: {
            title,
            description,
          },
          status: {
            privacyStatus: privacy,
          },
        }
      );

      return result(data);
    }
  );

  return server;
}

// ------------------------------------
// CLOUDFLARE WORKER ENTRY POINT
// ------------------------------------

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const handler = createMcpHandler(() => createServer(env));

    return handler(request, env, ctx);
  },
};
