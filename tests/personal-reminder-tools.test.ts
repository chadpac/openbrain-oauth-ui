import { strict as assert } from "node:assert";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createClient } from "@supabase/supabase-js";
import { registerPersonalReminderTools } from "../supabase/functions/_shared/personal-reminder-tools.ts";

const user = "00000000-0000-4000-8000-000000000001";
const home = "00000000-0000-4000-8000-000000000002";
const id = "00000000-0000-4000-8000-000000000003";
const other = "00000000-0000-4000-8000-000000000004";
const future = () => new Date(Date.now() + 86400000).toISOString();
const payload = (r: any) => JSON.parse(r.content[0].text);

async function setup() {
  const state = {
    tasks: new Map<string, any>(), calls: [] as { path: string; query: URLSearchParams; method: string; body: any }[],
    device: true, telegram: false, settingsError: false, readError: false,
    insertFailure: false, commitThenFail: false, preference: null as any,
  };
  const db = createClient("https://reminders-fixture.supabase.co", "fixture-publishable-key", {
    auth: { persistSession: false, autoRefreshToken: false }, global: {
      headers: { authorization: "Bearer fixture-caller-jwt" },
      fetch: async (input, init) => {
        const request = new Request(input, init), u = new URL(request.url);
        assert.equal(u.hostname, "reminders-fixture.supabase.co");
        assert.equal(request.headers.get("authorization"), "Bearer fixture-caller-jwt");
        assert.equal(request.headers.get("apikey"), "fixture-publishable-key");
        const path = u.pathname, query = u.searchParams;
        const body = request.method === "POST" ? await request.json() : null;
        state.calls.push({ path, query, method: request.method, body });
        const failure = () => Response.json({ message: "Synthetic transport error", code: "fixture" }, { status: 500 });
        if (path.endsWith("/family_tasks")) {
          if (body) {
            assert.equal(body.created_by, user); assert.equal(body.assigned_to_user_id, user);
            assert.equal(body.household_id, home); assert.equal(body.visibility, "private");
            if (state.insertFailure) return failure();
            if (state.tasks.has(body.id)) return Response.json({ code: "23505", message: "Duplicate fixture" }, { status: 409 });
            const saved = { ...body, reminder_sent_at: null, reminder_error: null };
            state.tasks.set(body.id, saved);
            if (state.commitThenFail) return failure();
            return Response.json(saved);
          }
          assert.equal(query.get("created_by"), "eq." + user);
          assert.equal(query.get("assigned_to_user_id"), "eq." + user);
          assert.equal(query.get("household_id"), "eq." + home);
          if (state.readError) return failure();
          const saved = state.tasks.get(query.get("id")!.slice(3));
          return Response.json(saved && saved.created_by === user && saved.assigned_to_user_id === user && saved.household_id === home ? saved : null);
        }
        if (state.settingsError) return failure();
        if (path.endsWith("/household_members")) {
          assert.equal(query.get("user_id"), "eq." + user); assert.equal(query.get("household_id"), "eq." + home);
          return Response.json({ display_name: "Fixture person", telegram_enabled: state.telegram, telegram_chat_id: state.telegram ? "fixture-never-send" : null });
        }
        if (path.endsWith("/push_subscriptions")) {
          assert.equal(query.get("user_id"), "eq." + user);
          assert.equal(query.get("select"), "id"); assert.equal(query.get("task_notifications"), "eq.true");
          return Response.json(state.device ? [{ id: "fixture-device" }] : []);
        }
        if (path.endsWith("/notification_preferences")) {
          assert.equal(query.get("owner_user_id"), "eq." + user); return Response.json(state.preference);
        }
        if (path.endsWith("/households")) {
          assert.equal(query.get("id"), "eq." + home); return Response.json({ timezone: "America/Denver" });
        }
        throw Error("Unexpected fixture request " + path);
      },
    },
  });
  const server = new McpServer({ name: "reminders-test", version: "1" });
  registerPersonalReminderTools(server, async () => ({ client: db, userId: user, householdId: home }));
  const client = new Client({ name: "synthetic-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(a), client.connect(b)]);
  return { state, client, call: (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }), close: () => Promise.all([client.close(), server.close()]) };
}
const args = (extra: Record<string, unknown> = {}) => ({ request_id: id, title: "Fixture reminder", remind_at: future(), ...extra });
const check = (name: string, fn: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) => Deno.test(name, async () => {
  const f = await setup(); try { await fn(f); } finally { await f.close(); }
});

check("three discoverable tools distinguish settings, private writes and saved status", async ({ client }) => {
  const { tools } = await client.listTools(); assert.equal(tools.length, 3);
  assert.equal(tools.find(t => t.name === "create_personal_reminder")?.annotations?.idempotentHint, true);
  assert.equal(tools.find(t => t.name === "get_my_reminder")?.annotations?.readOnlyHint, true);
});
check("settings expose channel booleans and timezone without device keys or Telegram IDs", async ({ call, state }) => {
  state.telegram = true; const value = payload(await call("get_my_reminder_settings"));
  assert.deepEqual(value.channels, { phone_or_browser: true, telegram: true });
  assert.equal(value.timezone, "America/Denver"); assert.equal(value.quiet_hours.enabled, false);
  assert(!JSON.stringify(value).includes("fixture-never-send")); assert(!JSON.stringify(value).includes("fixture-device"));
  assert(state.calls.every(c => c.method === "GET"));
});
check("personal reminder pins creator, assignee and household to the caller and stays private", async ({ call, state }) => {
  const value = payload(await call("create_personal_reminder", args({ user_id: other, household_id: other, visibility: "household", description: "Fixture detail" })));
  assert.equal(value.saved, true); assert.equal(value.replayed, false); assert.equal(value.delivery_status, "awaiting_delivery");
  assert.equal(value.reminder.visibility, "private"); assert(!JSON.stringify(value).includes("Fixture detail"));
  const task = state.tasks.get(id); assert.equal(task.created_by, user); assert.equal(task.assigned_to_user_id, user); assert.equal(task.household_id, home);
  assert.equal(task.recurrence_rule, null);
});
check("repeat retries reuse a single durable task ID", async ({ call, state }) => {
  const input = args(); const first = payload(await call("create_personal_reminder", input));
  const second = payload(await call("create_personal_reminder", input));
  assert.equal(first.reminder.id, second.reminder.id); assert.equal(second.replayed, true); assert.equal(state.tasks.size, 1);
  assert.equal(state.calls.filter(c => c.method === "POST").length, 1);
});
check("concurrent identical requests race through one insert and recover the unique-key loser", async ({ call, state }) => {
  const input = args();
  const values = await Promise.all([call("create_personal_reminder", input), call("create_personal_reminder", input)]);
  assert(values.every(r => payload(r).saved)); assert.equal(state.tasks.size, 1);
  assert(values.some(r => payload(r).replayed));
});
check("ambiguous insert failure recovers the committed reminder without a duplicate", async ({ call, state }) => {
  state.commitThenFail = true;
  const value = payload(await call("create_personal_reminder", args()));
  assert.equal(value.saved, true); assert.equal(value.replayed, true); assert.equal(state.tasks.size, 1);
});
check("retries after the scheduled time and device changes recover the original task", async ({ call, state }) => {
  const input = args({ remind_at: "2020-01-01T09:00:00-07:00" });
  state.tasks.set(id, { ...input, description: null, due_at: null, visibility: "private", created_by: user, assigned_to_user_id: user, household_id: home, recurrence_rule: null, status: "pending", reminder_sent_at: "2020-01-01T16:01:00Z", reminder_error: null });
  state.device = false; state.settingsError = true;
  const value = payload(await call("create_personal_reminder", input));
  assert.equal(value.replayed, true); assert.equal(value.delivery_status, "accepted_by_at_least_one_channel");
  assert.equal(state.calls.length, 1);
});
check("reused ID with changed content never overwrites or creates another reminder", async ({ call, state }) => {
  const input = args(); await call("create_personal_reminder", input);
  assert.equal((await call("create_personal_reminder", { ...input, title: "Changed" })).isError, true);
  assert.equal(state.tasks.size, 1); assert.equal(state.tasks.get(id).title, input.title);
});
check("another creator or assignee is unavailable to reminder status reads", async ({ call, state }) => {
  const input = args(); await call("create_personal_reminder", input);
  state.tasks.get(id).created_by = other;
  assert.equal((await call("get_my_reminder", { reminder_id: id })).isError, true);
  state.tasks.get(id).created_by = user; state.tasks.get(id).assigned_to_user_id = other;
  assert.equal((await call("get_my_reminder", { reminder_id: id })).isError, true);
});
check("missing channels require explicit save-without-delivery agreement", async ({ call, state }) => {
  state.device = false; const input = args();
  assert.equal((await call("create_personal_reminder", input)).isError, true); assert.equal(state.tasks.size, 0);
  const value = payload(await call("create_personal_reminder", { ...input, save_without_delivery: true }));
  assert.equal(value.saved, true); assert.equal(value.delivery.delivery_configured, false);
  assert.equal(value.delivery_status, "no_channel_configured");
});
check("bad or past timestamps and reminders after deadlines are rejected before writes", async ({ call, state }) => {
  for (const input of [args({ remind_at: "tomorrow" }), args({ remind_at: "2026-12-01T09:00:00" }), args({ remind_at: "2020-01-01T09:00:00Z" }), args({ due_at: "2020-01-01T09:00:00Z" })]) {
    assert.equal((await call("create_personal_reminder", input)).isError, true);
  }
  assert.equal(state.tasks.size, 0);
});
check("quiet hours at the reminder instant are disclosed without disabling them", async ({ call, state }) => {
  state.preference = { owner_user_id: user, quiet_hours_enabled: true, quiet_start: "22:00:00", quiet_end: "08:00:00", timezone: "America/Denver" };
  const time = new Date(Date.now() + 86400000 * 2); time.setUTCHours(7, 0, 0, 0);
  const value = payload(await call("create_personal_reminder", args({ remind_at: time.toISOString() })));
  assert.equal(value.quiet_at_reminder, true); assert.equal(value.delivery.quiet_hours.enabled, true);
});
check("unavailable settings and invalid quiet hours fail closed", async ({ call, state }) => {
  state.settingsError = true;
  assert.equal((await call("create_personal_reminder", args())).isError, true);
  state.settingsError = false; state.preference = { owner_user_id: user, quiet_hours_enabled: true, quiet_start: "22:00:00", quiet_end: "08:00:00", timezone: "Invalid/Zone" };
  assert.equal((await call("create_personal_reminder", args())).isError, true); assert.equal(state.tasks.size, 0);
});
check("unconfirmed insert and read failures never claim success", async ({ call, state }) => {
  state.insertFailure = true; assert.equal((await call("create_personal_reminder", args())).isError, true);
  state.insertFailure = false; state.readError = true;
  assert.equal((await call("create_personal_reminder", args())).isError, true); assert.equal(state.tasks.size, 0);
});
check("status distinguishes provider acceptance, error and inactive tasks without leaking raw errors", async ({ call, state }) => {
  await call("create_personal_reminder", args()); const task = state.tasks.get(id);
  task.reminder_error = "Sensitive provider response fixture";
  let value = payload(await call("get_my_reminder", { reminder_id: id }));
  assert.equal(value.delivery_status, "delivery_error"); assert.equal(value.needs_delivery_review, true);
  assert(!JSON.stringify(value).includes("Sensitive provider"));
  task.reminder_error = null; task.status = "cancelled";
  value = payload(await call("get_my_reminder", { reminder_id: id })); assert.equal(value.delivery_status, "inactive");
  task.reminder_sent_at = new Date().toISOString();
  value = payload(await call("get_my_reminder", { reminder_id: id })); assert.equal(value.delivery_status, "accepted_by_at_least_one_channel");
});
