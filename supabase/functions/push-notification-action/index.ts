import { createClient } from "npm:@supabase/supabase-js@2.119.0";

const SUPABASE_URL=Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin=createClient(SUPABASE_URL,SERVICE_KEY);

const cors={
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Headers":"content-type",
  "Access-Control-Allow-Methods":"POST,OPTIONS"
};

function json(body,status=200){
  return new Response(JSON.stringify(body),{status,headers:{...cors,"Content-Type":"application/json","Cache-Control":"no-store"}});
}

Deno.serve(async req=>{
  if(req.method==="OPTIONS") return new Response("ok",{headers:cors});
  if(req.method!=="POST") return json({error:"Method not allowed."},405);

  try{
    const body=await req.json();
    const token=typeof body?.token==="string"?body.token:"";
    const action=typeof body?.action==="string"?body.action:"";
    if(!token||!["done","snooze30"].includes(action)) return json({error:"Invalid action."},400);

    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token))return json({error:"Invalid action token."},400);
    const {data,error}=await admin.rpc("apply_open_brain_push_action",{p_token:token,p_action:action});
    if(error)throw new Error("Unable to process notification action.");
    if(!data)return json({error:"Unable to process notification action."},500);
    const {status,...result}=data;
    return json(result,status||200);
  }catch(err){
    console.error("Push action error:",err);
    return json({error:err instanceof Error?err.message:"Unable to process notification action."},500);
  }
});
