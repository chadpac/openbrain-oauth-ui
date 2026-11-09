import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { withSupabase } from "npm:@supabase/server@1";
import { ensureVapid, sendPushToUser } from "../_shared/push.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const handler = withSupabase({ auth: "user" }, async (req, { supabase }) => {
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return Response.json({ error: "Unauthorized." }, { status: 401, headers: corsHeaders });

  const body = await req.json().catch(() => ({}));
  const action = typeof body?.action === "string" ? body.action : "public_key";

  if (action === "public_key") {
    const { publicKey } = await ensureVapid(admin);
    return Response.json({ public_key: publicKey }, { headers: corsHeaders });
  }

  if (action === "test_self" || action === "test_device") {
    const endpoint = action === "test_device" && typeof body?.endpoint === "string" ? body.endpoint : undefined;
    const result = await sendPushToUser(admin, user.id, {
      title: "Open Brain test notification",
      body: "Your notification settings are working on this device.",
      url: "/openbrain-oauth-ui/dashboard/",
      tag: "open-brain-test"
    }, endpoint);
    return Response.json({ ok: result.sent > 0, ...result }, { headers: corsHeaders });
  }

  if (action === "client_error") {
    const stage = typeof body?.stage === "string" ? body.stage.slice(0,80) : "unknown";
    const name = typeof body?.name === "string" ? body.name.slice(0,120) : "";
    const message = typeof body?.message === "string" ? body.message.slice(0,1000) : "";
    const permission = typeof body?.notification_permission === "string" ? body.notification_permission.slice(0,40) : "";
    const standalone = !!body?.standalone;
    const userAgent = typeof body?.user_agent === "string" ? body.user_agent.slice(0,500) : "";
    console.error("WEB_PUSH_CLIENT_ERROR", JSON.stringify({
      user_id:user.id, stage, name, message, permission, standalone, user_agent:userAgent
    }));
    return Response.json({ logged:true }, { headers:corsHeaders });
  }

  return Response.json({ error: "Unknown action." }, { status: 400, headers: corsHeaders });
});

Deno.serve((req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return Response.json({ error: "Method not allowed." }, { status: 405, headers: corsHeaders });
  return handler(req);
});
