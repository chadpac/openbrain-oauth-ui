import { strict as assert } from "node:assert";
import { generateKeyPair, exportJWK, SignJWT } from "npm:jose@6.2.17";

// Import the deployed entrypoints with only synthetic environment values. Capture
// their actual Deno.serve handlers; never connect to Supabase, email or a model.
const handlers: ((request: Request) => Response | Promise<Response>)[] = [];
const originalServe = Deno.serve;
const originalFetch = globalThis.fetch;
let outbound = 0;
const values = { SUPABASE_URL: "https://spaces-fixture.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "fixture-service-key", SUPABASE_ANON_KEY: "fixture-anon-key", OPENROUTER_API_KEY: "fixture-model-key", MCP_ACCESS_KEY: "fixture-shared-key" };
for (const [key, value] of Object.entries(values)) Deno.env.set(key, value);
const userId = "00000000-0000-4000-8000-000000000001";
const spaceId = "00000000-0000-4000-8000-000000000003";
const { publicKey, privateKey } = await generateKeyPair("ES256");
Deno.env.set("SUPABASE_JWKS", JSON.stringify({ keys: [{ ...await exportJWK(publicKey), kid: "fixture", alg: "ES256", use: "sig" }] }));
Deno.env.set("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_fixture");
const token = await new SignJWT({ role: "authenticated", sub: userId, aud: "authenticated" }).setProtectedHeader({ alg: "ES256", kid: "fixture" }).setIssuer(values.SUPABASE_URL + "/auth/v1").setIssuedAt().setExpirationTime("5m").sign(privateKey);
Object.defineProperty(Deno, "serve", { configurable: true, value: (handler: typeof handlers[number]) => { handlers.push(handler); return {}; } });
globalThis.fetch = () => { outbound++; throw Error("No external reads allowed in authentication tests"); };
try {
  await import("../supabase/functions/open-brain-gemini-oauth/index.ts");
  await import("../supabase/functions/open-brain-mcp/index.ts");
} finally {
  Object.defineProperty(Deno, "serve", { configurable: true, value: originalServe });
}
const [oauth, shared] = handlers;
const body = (method = "tools/list", args?: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(args ? { params: args } : {}) });
const headers = { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" };
const url = "https://spaces-fixture.supabase.co/functions/v1/open-brain-gemini-oauth";
const decode = (text: string) => JSON.parse(text.includes("data:") ? text.split("data:")[1].trim() : text);

Deno.test("OAuth rejects absent credentials even with forged identity headers or the parent key", async () => {
  try {
    const attempts: Record<string, string>[] = [{}, { "x-openbrain-user-id": "fixture-user", "x-openbrain-household-id": "fixture-household", "x-openbrain-is-admin": "true" }, { "x-brain-key": "fixture-shared-key" }];
    for (const more of attempts) {
      const response = await oauth(new Request(url, { method: "POST", headers: { ...headers, ...more }, body: body() }));
      assert.equal(response.status, 401); assert(response.headers.get("www-authenticate")); await response.text();
    }
    assert.equal(outbound, 0);
  } finally { globalThis.fetch = originalFetch; }
});
Deno.test("OAuth HEAD and preflight remain available without revealing tools/content", async () => {
  for (const method of ["HEAD", "OPTIONS"]) { const response = await oauth(new Request(url, { method })); assert.equal(response.status, 200); await response.text(); }
});
Deno.test("legacy missing/invalid keys retain the JSON-RPC authorization envelope", async () => {
  for (const key of ["", "wrong"]) {
    const response = await shared(new Request(url.replace("gemini-oauth", "mcp"), { method: "POST", headers: { ...headers, "x-brain-key": key }, body: body() }));
    assert.equal(response.status, 200); const data = await response.json(); assert.equal(data.error.code, -32001);
  }
});
Deno.test("legacy authenticated discovery retains all eight old tools and adds six Space tools", async () => {
  const response = await shared(new Request(url.replace("gemini-oauth", "mcp"), { method: "POST", headers: { ...headers, "x-brain-key": "fixture-shared-key" }, body: body() }));
  assert.equal(response.status, 200); const text = await response.text();
  const data = decode(text);
  const names = data.result.tools.map((t: { name: string }) => t.name);
  for (const name of ["search", "fetch", "search_thoughts", "list_thoughts", "thought_stats", "capture_thought", "list_family_members", "create_family_task", "list_spaces", "get_space", "find_space_sources", "add_space_note", "add_space_document", "link_space_item"]) assert(names.includes(name), name);
  assert.equal(names.length, 14);
});
Deno.test("legacy authenticated Space calls request OAuth and never use the service client", async () => {
  const response = await shared(new Request(url.replace("gemini-oauth", "mcp"), { method: "POST", headers: { ...headers, "x-brain-key": "fixture-shared-key" }, body: body("tools/call", { name: "list_spaces", arguments: {} }) }));
  const text = await response.text(); const data = decode(text);
  assert.equal(data.result.isError, true); assert.match(data.result.content[0].text, /personal Open Brain OAuth/); assert.equal(outbound, 0);
});

Deno.test("verified OAuth identity supplies the caller JWT to every Space read/write despite forged scope headers", async () => {
  const requests: { path: string; authorization: string | null; apikey: string | null; body: any }[] = [];
  let role = "admin";
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init); const path = new URL(request.url).pathname;
    assert.equal(new URL(request.url).hostname, "spaces-fixture.supabase.co");
    requests.push({ path, authorization: request.headers.get("authorization"), apikey: request.headers.get("apikey"), body: request.method === "POST" ? await request.json() : null });
    let data: unknown;
    const space = { id: spaceId, name: "School", owner_user_id: userId, visibility: "private", version: 1, created_at: "2026-11-15T12:00:00Z" };
    if (path === "/auth/v1/user") data = { id: userId, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-11-15T12:00:00Z" };
    else if (path === "/rest/v1/household_members") data = [{ role, household_id: "00000000-0000-4000-8000-000000000002" }];
    else if (path === "/rest/v1/rpc/list_open_brain_spaces") data = { spaces: [space], has_more: false };
    else if (path === "/rest/v1/rpc/get_open_brain_space") data = { space, items: [], view: null };
    else if (path === "/rest/v1/rpc/save_open_brain_space_item") data = { id: "00000000-0000-4000-8000-000000000004", kind: "note", title: "Fixture note", version: 1 };
    else throw Error("Unexpected external request: " + path);
    return Response.json(data);
  };
  try {
    const call = async (name: string, args: unknown) => {
      const response = await oauth(new Request(url, { method: "POST", headers: { ...headers, authorization: "Bearer " + token, "x-openbrain-user-id": "spoofed", "x-openbrain-household-id": "spoofed", "x-openbrain-is-admin": "true" }, body: body("tools/call", { name, arguments: args }) }));
      const text = await response.text();
      return { response, data: response.status === 200 ? decode(text) : text };
    };
    const listed = await call("list_spaces", {});
    assert.equal(listed.response.status, 200); assert.equal(listed.data.result.isError, undefined);
    assert.equal(JSON.parse(listed.data.result.content[0].text).spaces[0].can_edit, true);
    const saved = await call("add_space_note", { space_id: spaceId, space_version: 1, request_id: "00000000-0000-4000-8000-000000000004", title: "Fixture note", content: "Fixture body" });
    assert.equal(saved.data.result.isError, undefined); assert.equal(JSON.parse(saved.data.result.content[0].text).saved, true);
    for (const request of requests) { assert.equal(request.authorization, "Bearer " + token); assert.equal(request.apikey, "sb_publishable_fixture"); }
    const mutation = requests.find(r => r.path.endsWith("save_open_brain_space_item"))!;
    assert.equal(mutation.body.p_space_version, 1); assert.equal(mutation.body.p_body, "Fixture body"); assert.equal(mutation.body.user_id, undefined);
    role = "child"; const denied = await call("list_spaces", {}); assert.equal(denied.response.status, 403);
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test("personal reminders and household tasks use the caller JWT, never service role or forged scope", async () => {
  const home = "00000000-0000-4000-8000-000000000002";
  const reminderId = "00000000-0000-4000-8000-000000000005";
  let saved: any = null;
  let posts = 0;
  const paths: string[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init), u = new URL(request.url), q = u.searchParams;
    paths.push(u.pathname);
    assert.equal(u.hostname, "spaces-fixture.supabase.co");
    assert.equal(request.headers.get("authorization"), "Bearer " + token);
    assert.equal(request.headers.get("apikey"), "sb_publishable_fixture");
    if (u.pathname === "/auth/v1/user") return Response.json({ id: userId, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-11-15T12:00:00Z" });
    if (u.pathname.endsWith("/household_members")) {
      if (q.get("select") === "role,household_id") return Response.json({ role: "admin", household_id: home });
      assert.equal(q.get("household_id"), "eq." + home);
      const member = { role: "admin", display_name: "Fixture person", user_id: userId, household_id: home, telegram_enabled: false, telegram_chat_id: null };
      return Response.json(q.has("user_id") ? member : [member]);
    }
    if (u.pathname.endsWith("/push_subscriptions")) { assert.equal(q.get("user_id"), "eq." + userId); return Response.json([{ id: "fixture-device" }]); }
    if (u.pathname.endsWith("/notification_preferences")) { assert.equal(q.get("owner_user_id"), "eq." + userId); return Response.json(null); }
    if (u.pathname.endsWith("/households")) { assert.equal(q.get("id"), "eq." + home); return Response.json({ timezone: "America/Denver" }); }
    if (u.pathname.endsWith("/family_tasks")) {
      if (request.method === "POST") {
        const task = await request.json(); posts++;
        assert.equal(task.created_by, userId); assert.equal(task.assigned_to_user_id, userId); assert.equal(task.household_id, home);
        saved = { ...task, id: task.id ?? reminderId, reminder_sent_at: null, reminder_error: null };
        return Response.json(saved);
      }
      assert.equal(q.get("household_id"), "eq." + home); assert.equal(q.get("created_by"), "eq." + userId); assert.equal(q.get("assigned_to_user_id"), "eq." + userId);
      return Response.json(saved);
    }
    throw Error("Unexpected request: " + u.pathname);
  };
  const invoke = async (method: string, params?: unknown) => {
    const response = await oauth(new Request(url, { method: "POST", headers: { ...headers, authorization: "Bearer " + token, "x-openbrain-user-id": "spoofed", "x-openbrain-household-id": "spoofed", "x-openbrain-is-admin": "true" }, body: body(method, params) }));
    assert.equal(response.status, 200); return decode(await response.text());
  };
  const call = async (name: string, args: unknown = {}) => (await invoke("tools/call", { name, arguments: args })).result;
  try {
    const discovery = await invoke("tools/list");
    assert.equal(discovery.result.tools.length, 20);
    for (const name of ["get_my_reminder_settings", "create_personal_reminder", "get_my_reminder"]) assert(discovery.result.tools.some((t: any) => t.name === name));
    const input = { request_id: reminderId, title: "Fixture private reminder", remind_at: new Date(Date.now() + 86400000).toISOString() };
    const created = await call("create_personal_reminder", input); assert.equal(created.isError, undefined); assert.equal(saved.visibility, "private");
    const retried = await call("create_personal_reminder", input); assert.equal(JSON.parse(retried.content[0].text).replayed, true); assert.equal(posts, 1);
    const status = await call("get_my_reminder", { reminder_id: reminderId }); assert.equal(status.isError, undefined);
    const members = await call("list_family_members"); assert.equal(members.isError, undefined);
    const shared = await call("create_family_task", { title: "Explicit household fixture", assigned_to: "Fixture person", remind_at: input.remind_at });
    assert.equal(shared.isError, undefined); assert.equal(saved.visibility, "household"); assert.equal(posts, 2);
    assert(paths.every(p => p.startsWith("/auth/") || p.startsWith("/rest/")));
  } finally { globalThis.fetch = originalFetch; }
});
