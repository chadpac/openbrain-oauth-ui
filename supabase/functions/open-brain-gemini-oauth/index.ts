import type {} from "npm:@supabase/functions-js@2.119.0/src/edge-runtime.d.ts";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { registerSpaceTools, type SpaceRpcClient } from "../_shared/space-mcp-tools.ts";
import { registerPersonalReminderTools, type ReminderClient } from "../_shared/personal-reminder-tools.ts";
import { pipeline } from "@supabase/middleware";
import { withOAuthProtectedResource, withSupabase } from "@supabase/server";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
// Gemini OAuth endpoint: access requires a valid Supabase OAuth user token.
// The request is additionally restricted to household administrators below.

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

type ThoughtMatch = {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
  created_at: string;
};

type ThoughtRecord = {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at?: string | null;
};

const CITATION_BASE_URL =
  Deno.env.get("OPEN_BRAIN_CITATION_BASE_URL") || "https://openbrain.local/thoughts";

function thoughtTitle(content: string, createdAt?: string): string {
  const firstLine = content.replace(/\s+/g, " ").trim().slice(0, 80);
  const datePrefix = createdAt ? new Date(createdAt).toLocaleDateString() : "Open Brain";
  return firstLine ? `${datePrefix} - ${firstLine}` : `${datePrefix} thought`;
}

function thoughtUrl(id: string): string {
  return `${CITATION_BASE_URL.replace(/\/$/, "")}/${id}`;
}

async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/text-embedding-3-small",
      input: text,
    }),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(`OpenRouter embeddings failed: ${r.status} ${msg}`);
  }
  const d = await r.json();
  return d.data[0].embedding;
}

async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned (empty if none)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note"
Only extract what's explicitly there.`,
        },
        { role: "user", content: text },
      ],
    }),
  });
  const d = await r.json();
  try {
    return JSON.parse(d.choices[0].message.content);
  } catch {
    return { topics: ["uncategorized"], type: "observation" };
  }
}

// --- MCP Server Setup ---

type PersonalClient = SpaceRpcClient & ReminderClient;
function buildServer(userId: string, householdId: string, isAdmin: boolean, spaceClient: PersonalClient): McpServer {
  const visibilityFilter = isAdmin
    ? `visibility.eq.household,visibility.eq.parents,and(visibility.eq.private,created_by.eq.${userId})`
    : `visibility.eq.household,and(visibility.eq.private,created_by.eq.${userId})`;
  const server = new McpServer({
    name: "open-brain",
    version: "1.2.0",
  });

  // ChatGPT compatibility: restricted connector surfaces, company knowledge, and deep
  // research look for exact read-only `search` and `fetch` tool shapes.
  server.registerTool(
    "search",
    {
      title: "Search Open Brain",
      description:
        "Search Open Brain memories by meaning. Returns relevant stored thoughts for questions about previously saved information.",
      annotations: {
        readOnlyHint: true,
      },
      inputSchema: {
        query: z.string().describe("The search query to run against Open Brain thoughts"),
      },
    },
    async ({ query }) => {
      try {
        const qEmb = await getEmbedding(query);
        const { data, error } = await supabase.rpc("match_user_visible_thoughts", {
          query_embedding: qEmb,
          p_user_id: userId,
          p_household_id: householdId,
          p_is_admin: isAdmin,
          match_threshold: 0.5,
          match_count: 10,
          filter: {},
        });

        if (error) {
          return {
            content: [{ type: "text" as const, text: `Search error: ${error.message}` }],
            isError: true,
          };
        }

        const results = ((data || []) as ThoughtMatch[]).map((t) => ({
          id: t.id,
          title: thoughtTitle(t.content, t.created_at),
          url: thoughtUrl(t.id),
        }));

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ results }) }],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "fetch",
    {
      title: "Fetch Open Brain Thought",
      description:
        "Fetch one Open Brain thought by ID after using search. Use this read-only compatibility tool to retrieve the full text and metadata for citation.",
      annotations: {
        readOnlyHint: true,
      },
      inputSchema: {
        id: z.string().describe("The Open Brain thought ID returned by the search tool"),
      },
    },
    async ({ id }) => {
      try {
        const { data, error } = await supabase
          .from("thoughts")
          .select("id, content, metadata, created_at, updated_at, visibility, created_by, household_id, archived_at")
          .eq("id", id)
          .eq("household_id", householdId)
          .is("archived_at", null)
          .maybeSingle();

        if (error) {
          return {
            content: [{ type: "text" as const, text: `Fetch error: ${error.message}` }],
            isError: true,
          };
        }

        const canView = !!data && (
          data.visibility === "household" ||
          (data.visibility === "private" && data.created_by === userId) ||
          (data.visibility === "parents" && isAdmin)
        );

        if (!canView) {
          return {
            content: [{ type: "text" as const, text: "Thought not found or you do not have permission to view it." }],
            isError: true,
          };
        }

        const thought = data as ThoughtRecord;
        const document = {
          id: thought.id,
          title: thoughtTitle(thought.content, thought.created_at),
          text: thought.content,
          url: thoughtUrl(thought.id),
          metadata: {
            ...thought.metadata,
            created_at: thought.created_at,
            updated_at: thought.updated_at,
          },
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(document) }],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool 1: Semantic Search
  server.registerTool(
    "search_thoughts",
    {
      title: "Search Thoughts",
      description:
        "Search captured thoughts by meaning. Use this when the user asks about a topic, person, or idea they've previously captured.",
      annotations: {
        readOnlyHint: true,
      },
      inputSchema: {
        query: z.string().describe("What to search for"),
        limit: z.number().optional().default(10),
        threshold: z.number().optional().default(0.5),
      },
    },
    async ({ query, limit, threshold }) => {
      try {
        const qEmb = await getEmbedding(query);
        const { data, error } = await supabase.rpc("match_user_visible_thoughts", {
          query_embedding: qEmb,
          p_user_id: userId,
          p_household_id: householdId,
          p_is_admin: isAdmin,
          match_threshold: threshold,
          match_count: limit,
          filter: {},
        });

        if (error) {
          return {
            content: [{ type: "text" as const, text: `Search error: ${error.message}` }],
            isError: true,
          };
        }

        if (!data || data.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No thoughts found matching "${query}".` }],
          };
        }

        const results = data.map(
          (
            t: ThoughtMatch,
            i: number
          ) => {
            const m = t.metadata || {};
            const parts = [
              `--- Result ${i + 1} (${(t.similarity * 100).toFixed(1)}% match) ---`,
              `Captured: ${new Date(t.created_at).toLocaleDateString()}`,
              `Type: ${m.type || "unknown"}`,
            ];
            if (Array.isArray(m.topics) && m.topics.length)
              parts.push(`Topics: ${(m.topics as string[]).join(", ")}`);
            if (Array.isArray(m.people) && m.people.length)
              parts.push(`People: ${(m.people as string[]).join(", ")}`);
            if (Array.isArray(m.action_items) && m.action_items.length)
              parts.push(`Actions: ${(m.action_items as string[]).join("; ")}`);
            parts.push(`\n${t.content}`);
            return parts.join("\n");
          }
        );

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${data.length} thought(s):\n\n${results.join("\n\n")}`,
            },
          ],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool 2: List Recent
  server.registerTool(
    "list_thoughts",
    {
      title: "List Recent Thoughts",
      description:
        "List recently captured thoughts with optional filters by type, topic, person, or time range.",
      annotations: {
        readOnlyHint: true,
      },
      inputSchema: {
        limit: z.number().optional().default(10),
        type: z.string().optional().describe("Filter by type: observation, task, idea, reference, person_note"),
        topic: z.string().optional().describe("Filter by topic tag"),
        person: z.string().optional().describe("Filter by person mentioned"),
        days: z.number().optional().describe("Only thoughts from the last N days"),
      },
    },
    async ({ limit, type, topic, person, days }) => {
      try {
        let q = supabase
          .from("thoughts")
          .select("content, metadata, created_at")
          .eq("household_id", householdId)
          .or(visibilityFilter)
          .is("archived_at", null)
          .order("created_at", { ascending: false })
          .limit(limit);

        if (type) q = q.contains("metadata", { type });
        if (topic) q = q.contains("metadata", { topics: [topic] });
        if (person) q = q.contains("metadata", { people: [person] });
        if (days) {
          const since = new Date();
          since.setDate(since.getDate() - days);
          q = q.gte("created_at", since.toISOString());
        }

        const { data, error } = await q;

        if (error) {
          return {
            content: [{ type: "text" as const, text: `Error: ${error.message}` }],
            isError: true,
          };
        }

        if (!data || !data.length) {
          return { content: [{ type: "text" as const, text: "No thoughts found." }] };
        }

        const results = data.map(
          (
            t: { content: string; metadata: Record<string, unknown>; created_at: string },
            i: number
          ) => {
            const m = t.metadata || {};
            const tags = Array.isArray(m.topics) ? (m.topics as string[]).join(", ") : "";
            return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] (${m.type || "??"}${tags ? " - " + tags : ""})\n   ${t.content}`;
          }
        );

        return {
          content: [
            {
              type: "text" as const,
              text: `${data.length} recent thought(s):\n\n${results.join("\n\n")}`,
            },
          ],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool 3: Stats
  server.registerTool(
    "thought_stats",
    {
      title: "Thought Statistics",
      description: "Get a summary of all captured thoughts: totals, types, top topics, and people.",
      annotations: {
        readOnlyHint: true,
      },
      inputSchema: {},
    },
    async () => {
      try {
        const { count } = await supabase
          .from("thoughts")
          .select("*", { count: "exact", head: true })
          .eq("household_id", householdId)
          .or(visibilityFilter)
          .is("archived_at", null);

        const { data } = await supabase
          .from("thoughts")
          .select("metadata, created_at")
          .eq("household_id", householdId)
          .or(visibilityFilter)
          .is("archived_at", null)
          .order("created_at", { ascending: false });

        const types: Record<string, number> = {};
        const topics: Record<string, number> = {};
        const people: Record<string, number> = {};

        for (const r of data || []) {
          const m = (r.metadata || {}) as Record<string, unknown>;
          if (m.type) types[m.type as string] = (types[m.type as string] || 0) + 1;
          if (Array.isArray(m.topics))
            for (const t of m.topics) topics[t as string] = (topics[t as string] || 0) + 1;
          if (Array.isArray(m.people))
            for (const p of m.people) people[p as string] = (people[p as string] || 0) + 1;
        }

        const sort = (o: Record<string, number>): [string, number][] =>
          Object.entries(o)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);

        const lines: string[] = [
          `Total thoughts: ${count}`,
          `Date range: ${
            data?.length
              ? new Date(data[data.length - 1].created_at).toLocaleDateString() +
                " → " +
                new Date(data[0].created_at).toLocaleDateString()
              : "N/A"
          }`,
          "",
          "Types:",
          ...sort(types).map(([k, v]) => `  ${k}: ${v}`),
        ];

        if (Object.keys(topics).length) {
          lines.push("", "Top topics:");
          for (const [k, v] of sort(topics)) lines.push(`  ${k}: ${v}`);
        }

        if (Object.keys(people).length) {
          lines.push("", "People mentioned:");
          for (const [k, v] of sort(people)) lines.push(`  ${k}: ${v}`);
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool 4: Capture Thought
  server.registerTool(
    "capture_thought",
    {
      title: "Capture Thought",
      description:
        "Save a durable memory/note to Open Brain. Use this for facts, notes, insights, decisions, or reference information. Do NOT use this for shopping/list items; use add_list_item. Do NOT use this for scheduled reminders/tasks; use create_family_task.",
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
      inputSchema: {
        content: z.string().describe("The thought to capture — a clear, standalone statement that will make sense when retrieved later by any AI"),
      },
    },
    async ({ content }) => {
      try {
        const [embedding, metadata] = await Promise.all([
          getEmbedding(content),
          extractMetadata(content),
        ]);

        const { data: thought, error: captureError } = await supabase
          .from("thoughts")
          .insert({
            content,
            embedding,
            metadata: { ...metadata, source: "gemini_oauth" },
            household_id: householdId,
            created_by: userId,
            visibility: "private",
          })
          .select("id")
          .single();

        if (captureError) {
          return {
            content: [{ type: "text" as const, text: `Failed to capture: ${captureError.message}` }],
            isError: true,
          };
        }

        const thoughtId = thought.id;

        const meta = metadata as Record<string, unknown>;
        let confirmation = `Captured as ${meta.type || "thought"}`;
        if (Array.isArray(meta.topics) && meta.topics.length)
          confirmation += ` — ${(meta.topics as string[]).join(", ")}`;
        if (Array.isArray(meta.people) && meta.people.length)
          confirmation += ` | People: ${(meta.people as string[]).join(", ")}`;
        if (Array.isArray(meta.action_items) && meta.action_items.length)
          confirmation += ` | Actions: ${(meta.action_items as string[]).join("; ")}`;

        return {
          content: [{ type: "text" as const, text: confirmation }],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );
  // Tool: List Open Brain Lists
  server.registerTool(
    "list_lists",
    {
      title: "List Open Brain Lists",
      description:
        "List visible Open Brain lists such as Shopping, Groceries, Packing, Wish List, Meal, or general lists. Use this when you need to identify the correct list before adding or reading items.",
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      inputSchema: {},
    },
    async () => {
      try {
        const { data, error } = await supabase
          .from("lists")
          .select("id,name,list_type,visibility,owner_user_id,archived_at")
          .eq("household_id", householdId)
          .or(`visibility.eq.household,and(visibility.eq.private,owner_user_id.eq.${userId})`)
          .is("archived_at", null)
          .order("updated_at", { ascending: false });

        if (error) {
          return {
            content: [{ type: "text" as const, text: `Failed to list Open Brain lists: ${error.message}` }],
            isError: true,
          };
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              lists: (data || []).map((l) => ({
                id: l.id,
                name: l.name,
                type: l.list_type,
                visibility: l.visibility,
              }))
            })
          }],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: Add Open Brain List Item
  server.registerTool(
    "add_list_item",
    {
      title: "Add Item to Open Brain List",
      description:
        "Add an item to an Open Brain list. ALWAYS use this tool for requests like add bread to Shopping, put milk on Groceries, add charger to Packing, or add an item to any shopping/grocery/packing/wish/meal/list. Do NOT use capture_thought for list-item requests.",
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
      inputSchema: {
        list_name: z.string().describe("Target list name, such as Shopping or Groceries"),
        item: z.string().describe("The item to add, such as bread"),
        quantity: z.string().optional().describe("Optional quantity, such as 2 or 1 loaf"),
        notes: z.string().optional().describe("Optional details such as brand, size, or store"),
      },
    },
    async ({ list_name, item, quantity, notes }) => {
      try {
        const cleanListName = list_name.trim();
        const cleanItem = item.trim();

        if (!cleanListName || !cleanItem) {
          return {
            content: [{ type: "text" as const, text: "Both list_name and item are required." }],
            isError: true,
          };
        }

        const { data: candidates, error: listError } = await supabase
          .from("lists")
          .select("id,name,list_type,visibility,owner_user_id")
          .eq("household_id", householdId)
          .or(`visibility.eq.household,and(visibility.eq.private,owner_user_id.eq.${userId})`)
          .is("archived_at", null)
          .ilike("name", cleanListName)
          .limit(5);

        if (listError) {
          return {
            content: [{ type: "text" as const, text: `Failed to find list: ${listError.message}` }],
            isError: true,
          };
        }

        let list = candidates?.[0] ?? null;

        if (!list) {
          const lower = cleanListName.toLowerCase();
          const inferredType =
            lower.includes("grocery") ? "grocery" :
            lower.includes("pack") ? "packing" :
            lower.includes("wish") ? "wish" :
            lower.includes("meal") ? "meal" :
            lower.includes("shop") ? "shopping" : "general";

          const { data: createdList, error: createListError } = await supabase
            .from("lists")
            .insert({
              household_id: householdId,
              owner_user_id: userId,
              name: cleanListName,
              list_type: inferredType,
              visibility: "private",
            })
            .select("id,name,list_type,visibility,owner_user_id")
            .single();

          if (createListError) {
            return {
              content: [{ type: "text" as const, text: `Failed to create list: ${createListError.message}` }],
              isError: true,
            };
          }

          list = createdList;
        }

        const { data: createdItem, error: itemError } = await supabase
          .from("list_items")
          .insert({
            household_id: householdId,
            owner_user_id: userId,
            list_id: list.id,
            list_name: list.name,
            content: cleanItem,
            quantity: quantity?.trim() || null,
            notes: notes?.trim() || null,
            visibility: list.visibility,
            completed: false,
          })
          .select("id,content,quantity,list_id")
          .single();

        if (itemError) {
          return {
            content: [{ type: "text" as const, text: `Failed to add list item: ${itemError.message}` }],
            isError: true,
          };
        }

        return {
          content: [{
            type: "text" as const,
            text: `Added "${createdItem.content}" to the Open Brain "${list.name}" list.`
          }],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: List Items on an Open Brain List
  server.registerTool(
    "list_list_items",
    {
      title: "List Items in an Open Brain List",
      description:
        "Read the current open items on a visible Open Brain list such as Shopping or Groceries.",
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      inputSchema: {
        list_name: z.string().describe("List name to read"),
        include_completed: z.boolean().optional().default(false),
      },
    },
    async ({ list_name, include_completed }) => {
      try {
        const { data: lists, error: listError } = await supabase
          .from("lists")
          .select("id,name,visibility,owner_user_id")
          .eq("household_id", householdId)
          .or(`visibility.eq.household,and(visibility.eq.private,owner_user_id.eq.${userId})`)
          .is("archived_at", null)
          .ilike("name", list_name.trim())
          .limit(1);

        if (listError) {
          return {
            content: [{ type: "text" as const, text: `Failed to find list: ${listError.message}` }],
            isError: true,
          };
        }

        const list = lists?.[0];
        if (!list) {
          return {
            content: [{ type: "text" as const, text: `No visible Open Brain list named "${list_name}" was found.` }],
            isError: true,
          };
        }

        let q = supabase
          .from("list_items")
          .select("id,content,quantity,notes,completed,created_at")
          .eq("list_id", list.id)
          .order("created_at", { ascending: true });

        if (!include_completed) q = q.eq("completed", false);

        const { data, error } = await q;
        if (error) {
          return {
            content: [{ type: "text" as const, text: `Failed to read list items: ${error.message}` }],
            isError: true,
          };
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ list: list.name, items: data || [] })
          }],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: List Family Members
  server.registerTool(
    "list_family_members",
    {
      title: "List Family Members",
      description:
        "List the family members available for assigning Open Brain household tasks and reminders. Use this before creating a task when you need to determine the correct family member name.",
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      inputSchema: {},
    },
    async () => {
      try {
        const { data: members, error } = await spaceClient
          .from("household_members")
          .select("display_name, role, user_id, household_id")
          .eq("household_id", householdId)
          .order("display_name");

        if (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to list family members: ${error.message}`,
              },
            ],
            isError: true,
          };
        }

        if (!members?.length) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No family members were found.",
              },
            ],
          };
        }

        const lines = members.map(
          (m) => `${m.display_name} (${m.role})`
        );

        return {
          content: [
            {
              type: "text" as const,
              text: `Family members:\n${lines.join("\n")}`,
            },
          ],
        };
      } catch (err: unknown) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );


  // Tool: Create Family Task
  server.registerTool(
    "create_family_task",
    {
      title: "Create Family Task",
      description:
        "Create an explicitly requested HOUSEHOLD-VISIBLE task in the signed-in user's household. For 'remind me' and other personal reminders, use create_personal_reminder instead, which stays private. The assigned_to value must exactly match a display name returned by list_family_members. remind_at and due_at should be ISO 8601 timestamps with a timezone offset. For recurring household tasks, recurrence_rule may be daily, weekdays, weekly, monthly, days:X, weeks:X, months:X, or weekdays:mon,wed,fri. Do not retry a household creation blindly after an interrupted response; it has no request ID.",
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
      inputSchema: {
        title: z.string().describe(
          "Short task title, for example: Take trash cans to the curb"
        ),

        assigned_to: z.string().describe(
          "Family member display name exactly as returned by list_family_members"
        ),

        description: z.string().optional().describe(
          "Optional additional instructions or details"
        ),

        remind_at: z.string().describe(
          "When to send the Telegram reminder, as an ISO 8601 timestamp including timezone offset"
        ),

        due_at: z.string().optional().describe(
          "Optional due date/time as an ISO 8601 timestamp including timezone offset"
        ),

        recurrence_rule: z.string().optional().describe(
          "Optional recurrence rule such as daily, weekdays, weekly, monthly, days:2, weeks:2, months:3, or weekdays:mon,wed,fri"
        ),

        priority: z
          .enum(["low", "normal", "high", "urgent"])
          .optional()
          .describe("Task priority. Defaults to normal"),

        category: z.string().optional().describe(
          "Task category. Defaults to household"
        ),
      },
    },

    async ({
      title,
      assigned_to,
      description,
      remind_at,
      due_at,
      recurrence_rule,
      priority,
      category,
    }) => {
      try {
        // Find the assigned family member.
        const { data: members, error: memberError } = await spaceClient
          .from("household_members")
          .select("user_id, household_id, display_name")
          .eq("household_id", householdId)
          .eq("display_name", assigned_to)
          .limit(2);

        if (memberError) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to find family member: ${memberError.message}`,
              },
            ],
            isError: true,
          };
        }

        if (!members?.length) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `I couldn't find a family member named "${assigned_to}". ` +
                  `Use list_family_members first to see the available names.`,
              },
            ],
            isError: true,
          };
        }

        if (members.length > 1) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `More than one family member matched "${assigned_to}". ` +
                  `Please use a more specific display name.`,
              },
            ],
            isError: true,
          };
        }

        const member = members[0];

        const { data: task, error: taskError } = await spaceClient
          .from("family_tasks")
          .insert({
            title,
            description: description ?? null,
            assigned_to: member.display_name,
            assigned_to_user_id: member.user_id,
            household_id: member.household_id,
            created_by: userId,
            category: category ?? "household",
            priority: priority ?? "normal",
            status: "pending",
            visibility: "household",
            remind_at,
            due_at: due_at ?? null,
            recurrence_rule: recurrence_rule ?? null,
          })
          .select(
            "id, title, assigned_to, remind_at, due_at, recurrence_rule, status"
          )
          .single();

        if (taskError) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to create task: ${taskError.message}`,
              },
            ],
            isError: true,
          };
        }

        let confirmation =
          `Created task "${task.title}" for ${task.assigned_to}.` +
          ` Reminder: ${task.remind_at}.`;

        if (task.recurrence_rule) {
          confirmation +=
            ` Repeats: ${task.recurrence_rule}.`;
        }

        return {
          content: [
            {
              type: "text" as const,
              text: confirmation,
            },
          ],
        };
      } catch (err: unknown) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
  
  registerSpaceTools(server, async () => ({ client: spaceClient, userId }));
  registerPersonalReminderTools(server, async () => ({ client: spaceClient, userId, householdId }));
  return server;
}

// --- Hono App with Auth + CORS ---

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-brain-key, accept, mcp-session-id, mcp-protocol-version, last-event-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
};

// JSON-RPC error code for unauthorized requests.
// Per the JSON-RPC 2.0 spec, the range -32099 to -32000 is reserved for
// implementation-defined server errors. -32001 is the conventional
// "Unauthorized" code used by MCP clients/servers in the wild.
//
// Why a JSON-RPC envelope (HTTP 200) instead of a bare HTTP 401?
// Strict MCP hosts (Codex CLI, Claude Code) treat bare HTTP 4xx responses
// as transport-level failures and tear the connection down rather than
// surfacing the failure to the application layer. Wrapping the auth
// rejection in a JSON-RPC error keeps the connection alive and lets
// clients recover (e.g. prompt the user for a new key, refetch a stale
// cache) instead of dying.
const JSON_RPC_UNAUTHORIZED_CODE = -32001;
const UNAUTHORIZED_MESSAGE = "Unauthorized: missing or invalid authentication.";

/**
 * Read the request body as text without consuming the original request's
 * body stream for downstream handlers. Returns null on bodyless methods
 * or read failure.
 */
async function readBodyText(req: Request): Promise<string | null> {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "DELETE") {
    return null;
  }
  try {
    return await req.text();
  } catch {
    return null;
  }
}

/**
 * Best-effort extraction of the JSON-RPC `id` from a raw request body.
 * Returns null when the body is missing, not JSON, or not a JSON-RPC
 * shape with an id. Per the JSON-RPC 2.0 spec, id may be a string,
 * number, or null — we preserve any of those; anything else becomes null.
 */
function extractJsonRpcId(bodyText: string | null): string | number | null {
  if (!bodyText) return null;
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed && typeof parsed === "object" && "id" in parsed) {
      const id = (parsed as { id: unknown }).id;
      if (typeof id === "string" || typeof id === "number" || id === null) {
        return id;
      }
    }
  } catch {
    // fall through — malformed body
  }
  return null;
}

/**
 * Build a JSON-RPC 2.0 error envelope response for auth failures.
 * Returns HTTP 200 — the JSON-RPC layer expresses the error so that
 * strict MCP clients keep the connection alive instead of treating
 * the failure as a transport-level fault.
 */
function unauthorizedResponse(id: string | number | null): Response {
  const body = {
    jsonrpc: "2.0",
    error: {
      code: JSON_RPC_UNAUTHORIZED_CODE,
      message: UNAUTHORIZED_MESSAGE,
    },
    id,
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });
}

const app = new Hono<{ Bindings: { spaceClient: PersonalClient } }>();

// CORS preflight — required for browser/Electron-based clients (Claude Desktop, claude.ai)
app.options("*", (c) => {
  return c.text("ok", 200, corsHeaders);
});

  app.all("*", async (c) => {
  // Gemini URL verification performs a HEAD request before the MCP handshake.
  // Return 200 immediately so URL verification succeeds without invoking MCP transport.
  if (c.req.method === "HEAD") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const scopedUserId = c.req.header("x-openbrain-user-id");
  const scopedHouseholdId = c.req.header("x-openbrain-household-id");
  const scopedIsAdmin = c.req.header("x-openbrain-is-admin") === "true";

  if (!scopedUserId || !scopedHouseholdId) {
    return new Response("Missing authenticated Open Brain scope", { status: 401, headers: corsHeaders });
  }

  const server = buildServer(scopedUserId, scopedHouseholdId, scopedIsAdmin, c.env.spaceClient);

  const transport = new StreamableHTTPTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const response = await transport.handleRequest(c);
  if (!response) return c.json({ error: "No response from MCP transport" }, 500, corsHeaders);
  response.headers.delete("mcp-session-id");
  for (const [k, v] of Object.entries(corsHeaders)) response.headers.set(k, v);
  return response;
});

const protectedMcp = pipeline(
  [withOAuthProtectedResource(), withSupabase({ auth: "user" })],
  async (req, { supabase: userSupabase }) => {
    const {
      data: { user },
      error: userError,
    } = await userSupabase.auth.getUser();

    if (userError || !user) {
      return new Response("Unauthorized", { status: 401, headers: corsHeaders });
    }

    const { data: member, error: memberError } = await userSupabase
      .from("household_members")
      .select("role, household_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (memberError || !member || member.role !== "admin") {
      return new Response("Forbidden", { status: 403, headers: corsHeaders });
    }

    const headers = new Headers(req.headers);
    headers.set("x-openbrain-user-id", user.id);
    headers.set("x-openbrain-household-id", member.household_id);
    headers.set("x-openbrain-is-admin", member.role === "admin" ? "true" : "false");

    const scopedRequest = new Request(req, { headers });
    return app.fetch(scopedRequest, { spaceClient: userSupabase });
  }
);

Deno.serve((req: Request) => {
  // Gemini verifies connector URLs with HEAD before beginning OAuth/MCP discovery.
  if (req.method === "HEAD") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  // Browser preflight must remain unauthenticated.
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  return protectedMcp(req);
});
