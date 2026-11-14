import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { createGmailService } from "../_shared/gmail.ts";
const admin=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false,autoRefreshToken:false}});
Deno.serve(createGmailService(admin,{supabaseUrl:Deno.env.get("SUPABASE_URL")!,clientId:Deno.env.get("GOOGLE_CALENDAR_CLIENT_ID")||"",clientSecret:Deno.env.get("GOOGLE_CALENDAR_CLIENT_SECRET")||""}).handle);
