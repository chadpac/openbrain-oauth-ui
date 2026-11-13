import { answerCalendarQuestion } from "./calendar-questions.ts";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "npm:@supabase/server@1";

const OPENROUTER_API_KEY=Deno.env.get("OPENROUTER_API_KEY")!;
const OPENROUTER_BASE="https://openrouter.ai/api/v1";
const PRIMARY_MODEL="openai/gpt-luna-latest";
const FALLBACK_MODEL="openai/gpt-4o-mini";

const corsHeaders={
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods":"POST, OPTIONS"
};

function json(body:any,status=200){
  return new Response(JSON.stringify(body),{
    status,
    headers:{...corsHeaders,"Content-Type":"application/json","Cache-Control":"no-store"}
  });
}

function compactRows(rows:any[]|null,keys:string[],limit=60){
  return (rows||[]).slice(0,limit).map(row=>{
    const out:any={};
    for(const key of keys){
      if(row?.[key]!==undefined&&row?.[key]!==null&&row?.[key]!=="")out[key]=row[key];
    }
    return out;
  });
}

function zonedParts(value:string|Date,timeZone:string){
  const d=value instanceof Date?value:new Date(value);
  if(Number.isNaN(d.getTime()))return null;
  const parts=new Intl.DateTimeFormat("en-US",{
    timeZone,
    year:"numeric",month:"2-digit",day:"2-digit",
    hour:"2-digit",minute:"2-digit",second:"2-digit",
    hourCycle:"h23",
    timeZoneName:"short"
  }).formatToParts(d);
  const get=(type:string)=>parts.find(p=>p.type===type)?.value||"";
  return{
    year:get("year"),month:get("month"),day:get("day"),
    hour:get("hour"),minute:get("minute"),second:get("second"),
    zone:get("timeZoneName")
  };
}

function zonedDateKey(value:string|Date,timeZone:string){
  const p=zonedParts(value,timeZone);
  return p?`${p.year}-${p.month}-${p.day}`:"";
}

function zonedDisplay(value:string|Date|null,timeZone:string){
  if(!value)return null;
  const d=value instanceof Date?value:new Date(value);
  if(Number.isNaN(d.getTime()))return null;
  return new Intl.DateTimeFormat("en-US",{
    timeZone,
    weekday:"long",month:"long",day:"numeric",year:"numeric",
    hour:"numeric",minute:"2-digit",timeZoneName:"short"
  }).format(d);
}

function dateKeyToUtcMs(key:string){
  const m=key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(!m)return NaN;
  return Date.UTC(Number(m[1]),Number(m[2])-1,Number(m[3]));
}

function scheduleRelation(value:string|null|undefined,timeZone:string,now:Date,status?:string){
  if(!value)return "unscheduled";
  const targetKey=zonedDateKey(value,timeZone);
  const todayKey=zonedDateKey(now,timeZone);
  if(!targetKey||!todayKey)return "unknown";
  const dayDiff=Math.round((dateKeyToUtcMs(targetKey)-dateKeyToUtcMs(todayKey))/86400000);
  const active=status==="pending"||status==="in_progress"||status==="paused";
  if(dayDiff<0)return active?"overdue":"past";
  if(dayDiff===0){
    if(active&&new Date(value).getTime()<now.getTime())return "overdue_today";
    return "today";
  }
  if(dayDiff===1)return "tomorrow";
  return "future";
}

function enrichTasks(rows:any[]|null,timeZone:string,now:Date){
  return (rows||[]).slice(0,100).map((row:any)=>{
    const schedule=row.remind_at||row.due_at||null;
    return{
      id:row.id,
      title:row.title,
      description:row.description||null,
      assigned_to:row.assigned_to||null,
      assigned_to_user_id:row.assigned_to_user_id||null,
      priority:row.priority||"normal",
      status:row.status,
      recurrence_rule:row.recurrence_rule||null,
      estimated_minutes:row.estimated_minutes??null,
      visibility:row.visibility||null,
      remind_at_local:zonedDisplay(row.remind_at,timeZone),
      remind_date_local:row.remind_at?zonedDateKey(row.remind_at,timeZone):null,
      due_at_local:zonedDisplay(row.due_at,timeZone),
      due_date_local:row.due_at?zonedDateKey(row.due_at,timeZone):null,
      schedule_relation:scheduleRelation(schedule,timeZone,now,row.status),
      completed_at_local:zonedDisplay(row.completed_at,timeZone)
    };
  });
}

function enrichEvents(rows:any[]|null,timeZone:string,now:Date){
  return (rows||[]).slice(0,50).map((row:any)=>({
    id:row.id,
    title:row.title,
    description:row.description||null,
    location:row.location||null,
    all_day:!!row.all_day,
    created_by:row.created_by,
    starts_at_local:zonedDisplay(row.starts_at,timeZone),
    starts_date_local:row.starts_at?zonedDateKey(row.starts_at,timeZone):null,
    ends_at_local:zonedDisplay(row.ends_at,timeZone),
    schedule_relation:scheduleRelation(row.starts_at,timeZone,now,"pending")
  }));
}

async function getQueryEmbedding(text:string){
  const response=await fetch(`${OPENROUTER_BASE}/embeddings`,{
    method:"POST",
    headers:{
      Authorization:`Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type":"application/json",
      "HTTP-Referer":"https://chadpac.github.io/openbrain-oauth-ui/",
      "X-Title":"Open Brain"
    },
    body:JSON.stringify({model:"openai/text-embedding-3-small",input:text})
  });
  if(!response.ok)throw new Error("Embedding service unavailable.");
  const data=await response.json();
  const embedding=data?.data?.[0]?.embedding;
  if(!Array.isArray(embedding))throw new Error("Invalid embedding response.");
  return embedding;
}

async function retrieveSemanticMemories(client:any,query:string){
  try{
    const embedding=await getQueryEmbedding(query);
    const {data:matches,error:matchError}=await client.rpc("match_thoughts",{
      query_embedding:embedding,
      match_threshold:0.32,
      match_count:8,
      filter:{}
    });
    if(matchError)throw matchError;
    if(!matches?.length)return[];
    return matches.map((m:any)=>({
      id:m.id,
      content:m.content,
      metadata:m.metadata||{},
      similarity:Number(m.similarity||0)
    }));
  }catch(err){
    console.warn("Semantic memory retrieval skipped:",err instanceof Error?err.message:String(err));
    return[];
  }
}

function inferShoppingFallback(message:string,lists:any[]){
  const raw=String(message||"").trim();
  if(!/^\s*(add|put)\b/i.test(raw))return null;

  let match=raw.match(/^\s*add\s+(.+?)\s+(?:to|onto|into)\s+(?:the\s+)?(.+?)\s*[.!?]*$/i);
  if(!match){
    match=raw.match(/^\s*put\s+(.+?)\s+(?:on|onto|into)\s+(?:the\s+)?(.+?)\s*[.!?]*$/i);
  }
  if(!match)return null;

  const itemsText=match[1].trim();
  const targetText=match[2].trim().toLowerCase();
  if(!itemsText||!targetText)return null;

  const itemParts=itemsText
    .replace(/\s+and\s+/gi,",")
    .split(",")
    .map(x=>x.trim())
    .filter(Boolean)
    .slice(0,50);
  if(!itemParts.length)return null;

  const scored=(lists||[]).map((list:any)=>{
    const name=String(list?.name||"").trim().toLowerCase();
    if(!name)return{list,score:0};
    let score=0;
    if(targetText===name)score=100;
    else if(targetText.includes(name)||name.includes(targetText))score=80;
    else{
      const targetTokens=targetText.split(/\s+/).filter(Boolean);
      const nameTokens=name.split(/\s+/).filter(Boolean);
      score=targetTokens.filter((t:string)=>nameTokens.includes(t)).length*10;
      if(/grocer|shopping/.test(targetText)&&/grocer|shopping/.test(name))score+=40;
    }
    return{list,score};
  }).sort((a:any,b:any)=>b.score-a.score);

  const chosen=scored[0]?.score>0?scored[0].list:null;
  return{
    type:"list_items",
    label:itemParts.length===1?"Review item":`Review ${itemParts.length} items`,
    payload:{
      list_id:chosen?.id||null,
      list_name:chosen?.name||null,
      items:itemParts.map(content=>({content,quantity:null,notes:null}))
    }
  };
}

async function callModel(messages:any[]){
  let lastError="";
  for(const model of [PRIMARY_MODEL,FALLBACK_MODEL]){
    try{
      const response=await fetch(`${OPENROUTER_BASE}/chat/completions`,{
        method:"POST",
        headers:{
          Authorization:`Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type":"application/json",
          "HTTP-Referer":"https://chadpac.github.io/openbrain-oauth-ui/",
          "X-Title":"Open Brain"
        },
        body:JSON.stringify({
          model,
          temperature:0.2,
          response_format:{type:"json_object"},
          messages
        })
      });
      if(!response.ok){
        lastError=`${model}: ${response.status} ${await response.text().catch(()=>"")}`;
        console.error("Open Brain assistant model failed:",lastError);
        continue;
      }
      const data=await response.json();
      const raw=data?.choices?.[0]?.message?.content;
      if(typeof raw!=="string"||!raw.trim())throw new Error("Empty model response.");
      return {parsed:JSON.parse(raw),model};
    }catch(err){
      lastError=err instanceof Error?err.message:String(err);
      console.error("Open Brain assistant model error:",model,lastError);
    }
  }
  throw new Error(lastError||"AI service unavailable.");
}

const handler=withSupabase({auth:"user"},async(req,ctx)=>{
  try{
    const body=await req.json().catch(()=>({}));
    const message=typeof body?.message==="string"?body.message.trim():"";
    if(!message)return json({error:"Message is required."},400);
    if(message.length>4000)return json({error:"Message is too long."},400);

    const refersToPriorProposal=/\b(that|those|them|it|also|instead|change|update|modify|make|remove|delete|same|hers|his|the milk|the eggs|the reminder|the event|the list)\b/i.test(message);
    const hasPriorProposal=Array.isArray(body?.history)&&body.history.some((m:any)=>
      m?.role==="assistant"&&Array.isArray(m?.actions)&&m.actions.length
    );
    const isProposalRevision=refersToPriorProposal&&hasPriorProposal;
    const history=Array.isArray(body?.history)
      ? body.history.filter((m:any)=>m?.source!=="google_calendar").slice(-10).map((m:any)=>{
          const role=m?.role==="assistant"?"assistant":"user";
          let content=String(m?.content||"").slice(0,2500);
          if(isProposalRevision&&role==="assistant"&&Array.isArray(m?.actions)&&m.actions.length){
            const safeActions=m.actions.slice(0,12).map((a:any)=>({
              type:a?.type,
              label:a?.label,
              payload:a?.payload
            }));
            content+="\n\nPROPOSED_ACTIONS_JSON:"+JSON.stringify(safeActions).slice(0,9000);
          }
          return {role,content};
        }).filter((m:any)=>m.content)
      : [];
    const pageContext=body?.page_context&&typeof body.page_context==="object"
      ? body.page_context
      : {};

    const {data:{user},error:userError}=await ctx.supabase.auth.getUser();
    if(userError||!user)return json({error:"Unauthorized."},401);

    const {data:member,error:memberError}=await ctx.supabase
      .from("household_members")
      .select("user_id,household_id,display_name,role")
      .eq("user_id",user.id)
      .maybeSingle();
    if(memberError||!member)return json({error:"Open Brain household not found."},403);

    const householdId=member.household_id;
    const now=new Date();
    if(body?.use_google_calendar===true){
      const {data:household,error:householdError}=await ctx.supabase.from("households")
        .select("timezone").eq("id",householdId).maybeSingle();
      if(householdError||!household)return json({error:"Household timezone is unavailable."},503);
      return json(await answerCalendarQuestion({
        message,client:ctx.supabase,householdId,
        authorization:req.headers.get("Authorization")||"",
        supabaseUrl:Deno.env.get("SUPABASE_URL")!,
        timeZone:household.timezone||"America/Denver",now,planner:callModel
      }));
    }
    const thirtyDaysAgo=new Date(now.getTime()-30*86400000).toISOString();
    const futureCutoff=new Date(now.getTime()+60*86400000).toISOString();

    const [
      householdRes,membersRes,tasksRes,eventsRes,goalsRes,habitsRes,habitCompletionsRes,
      weeksRes,listsRes,listItemsRes,memoriesRes,semanticMemories
    ]=await Promise.all([
      ctx.supabase.from("households").select("id,name,timezone").eq("id",householdId).maybeSingle(),
      ctx.supabase.from("household_members").select("user_id,display_name,role").eq("household_id",householdId).order("display_name"),
      ctx.supabase.from("family_tasks")
        .select("id,title,description,assigned_to,assigned_to_user_id,priority,status,due_at,remind_at,recurrence_rule,estimated_minutes,visibility,created_at,completed_at,updated_at")
        .eq("household_id",householdId)
        .order("updated_at",{ascending:false}).limit(100),
      ctx.supabase.from("family_events")
        .select("id,title,description,location,starts_at,ends_at,all_day,created_by")
        .eq("household_id",householdId)
        .gte("starts_at",thirtyDaysAgo)
        .lte("starts_at",futureCutoff)
        .order("starts_at",{ascending:true}).limit(50),
      ctx.supabase.from("family_goals")
        .select("id,owner_user_id,title,description,why_it_matters,next_action,progress_percent,target_date,status,visibility,featured")
        .eq("household_id",householdId)
        .in("status",["active","paused"])
        .order("updated_at",{ascending:false}).limit(30),
      ctx.supabase.from("habits")
        .select("id,title,description,weekdays,reminder_enabled,reminder_time,status,paused_until,goal_id")
        .eq("owner_user_id",user.id)
        .neq("status","archived")
        .order("created_at",{ascending:true}).limit(30),
      ctx.supabase.from("habit_completions")
        .select("habit_id,completed_on,created_at")
        .eq("owner_user_id",user.id)
        .gte("completed_on",new Date(now.getTime()-14*86400000).toISOString().slice(0,10))
        .order("completed_on",{ascending:false}).limit(100),
      ctx.supabase.from("weekly_plans")
        .select("week_start,priority_1,priority_2,priority_3,wins,lessons,carry_forward,status")
        .eq("owner_user_id",user.id)
        .order("week_start",{ascending:false}).limit(4),
      ctx.supabase.from("lists")
        .select("id,name,list_type,visibility,owner_user_id,archived_at")
        .eq("household_id",householdId)
        .is("archived_at",null)
        .order("updated_at",{ascending:false}).limit(30),
      ctx.supabase.from("list_items")
        .select("id,list_id,list_name,content,quantity,notes,completed,visibility,owner_user_id,completed_by,updated_at")
        .eq("household_id",householdId)
        .order("updated_at",{ascending:false}).limit(250),
      ctx.supabase.from("thoughts")
        .select("id,content,metadata,visibility,created_by,created_at,updated_at")
        .eq("household_id",householdId)
        .is("archived_at",null)
        .order("updated_at",{ascending:false}).limit(60),
      body?.skip_memory_search===true ? Promise.resolve([]) : retrieveSemanticMemories(ctx.supabase,message)
    ]);

    const errors=[
      householdRes.error,membersRes.error,tasksRes.error,eventsRes.error,goalsRes.error,
      habitsRes.error,habitCompletionsRes.error,weeksRes.error,listsRes.error,listItemsRes.error,memoriesRes.error
    ].filter(Boolean);
    if(errors.length)throw errors[0];

    const household=householdRes.data||{timezone:"America/Denver"};
    const members=membersRes.data||[];
    const visibleLists=listsRes.data||[];
    const visibleListIds=new Set(visibleLists.map((l:any)=>l.id));
    const visibleListItems=(listItemsRes.data||[]).filter((i:any)=>!i.list_id||visibleListIds.has(i.list_id));

    const timeZone=household.timezone||"America/Denver";
    const appContext={
      current_time_utc:now.toISOString(),
      household_timezone:timeZone,
      household_local_now:zonedDisplay(now,timeZone),
      household_local_date:zonedDateKey(now,timeZone),
      signed_in_person:{display_name:member.display_name,role:member.role,user_id:member.user_id},
      current_page:pageContext,
      family_members:compactRows(members,["user_id","display_name","role"],20),
      tasks:enrichTasks(tasksRes.data,timeZone,now),
      events:enrichEvents(eventsRes.data,timeZone,now),
      goals:compactRows(goalsRes.data,["id","owner_user_id","title","description","why_it_matters","next_action","progress_percent","target_date","status","visibility","featured"],30),
      my_habits:compactRows(habitsRes.data,["id","title","description","weekdays","reminder_enabled","reminder_time","status","paused_until","goal_id"],30),
      my_habit_completions:compactRows(habitCompletionsRes.data,["habit_id","completed_on"],100),
      my_weekly_plans:compactRows(weeksRes.data,["week_start","priority_1","priority_2","priority_3","wins","lessons","carry_forward","status"],4),
      lists:compactRows(visibleLists,["id","name","list_type","visibility","owner_user_id"],30),
      list_items:compactRows(visibleListItems,["id","list_id","list_name","content","quantity","notes","completed","visibility","owner_user_id","completed_by"],250),
      memories:compactRows(memoriesRes.data,["id","content","metadata","visibility","created_by","updated_at"],60),
      semantic_memory_matches:(semanticMemories||[]).slice(0,8)
    };

    const system=`You are Open Brain AI, a concise household organizer embedded inside a private family app.

You receive APP_CONTEXT containing only records this signed-in user is authorized to read through database row-level security. Treat APP_CONTEXT as private. Never infer or reveal records that are not present.

Task duration estimates are optional minutes. A null estimate means unknown; never treat it as zero or invent a saved estimate. A reminder time does not reserve calendar work time. For a new proposal, leave the estimate null unless the user specified a duration or explicitly asked you to estimate one.

Your job:
1. Answer questions about tasks, family events, goals, habits, weekly planning, lists, and memories using APP_CONTEXT.
2. Help organize and summarize. Be concise, friendly, and concrete.
3. For memory/location/reference questions, give extra weight to semantic_memory_matches because they were retrieved by meaning from the user's saved memories. Do not treat a low-similarity match as certain if it does not actually answer the question.
4. You may PROPOSE one or more actions when the user asks to create something, but you MUST NOT say anything was created, saved, scheduled, remembered, or changed. The UI will require the user to review and save each proposal. IMPORTANT: if the user asks you to add/create/remember/schedule something and you say you can propose it, you MUST include the corresponding structured action in the actions array; never return a text-only proposal.
5. CONVERSATION FOLLOW-UPS:
   - Assistant history may include PROPOSED_ACTIONS_JSON. Those are unsaved proposals from earlier in this chat.
   - When the user says things like "make that 2 gallons", "change it to 8", "also add bread", "make hers tomorrow", or other clearly referential follow-ups, revise or extend the relevant unsaved proposal using the prior structured proposal as context.
   - A fresh standalone command such as "Add milk, pasta, and sauce to the shopping list" starts a NEW proposal. Do not carry older unsaved proposal items into it unless the wording clearly refers back to them.
   - Return the full current proposal set needed after a true follow-up change, not just the changed field.
   - Do not claim an earlier proposal was saved unless APP_CONTEXT shows the saved record.
6. Never invent a date, time, family member, list, or stored fact. If a requested scheduling detail is unclear, say what is missing; you may still propose a draft with a null date/time for review.
7. TIME ZONE RULES ARE STRICT:
   - All human-readable task and event times in APP_CONTEXT are already converted to household_timezone.
   - For existing tasks/events, use remind_at_local, due_at_local, starts_at_local, ends_at_local, and schedule_relation. Never reinterpret or display the underlying UTC storage time.
   - "Today" means household_local_date, not the UTC calendar date.
   - If asked what is left "today", include only active tasks whose schedule_relation is "today" or "overdue_today". Do not include "tomorrow" or "future" tasks. Older "overdue" tasks may be mentioned separately only if useful and clearly labeled overdue.
   - "Tomorrow" means schedule_relation "tomorrow".
8. When choosing a family member or list, use an exact matching member/list from APP_CONTEXT. If unclear, leave the corresponding ID null.
   GENERIC SHOPPING LIST RULE: when the user says "shopping list", "groceries", "grocery list", or similar without explicitly saying private/personal, prefer a household-visible grocery/shopping list over a private list, even if a private list has a closer name.
9. Health data is intentionally not included in this version. Do not claim to have reviewed health information.
   Google Calendar data is also absent from APP_CONTEXT. Family events here are Open Brain records, not a complete Google schedule. To check Google calendars or actual availability, tell the user to enable "Check my Google Calendar for this question" before sending. Do not claim Google availability from this general context.
10. If the user asks a general-world question that is not answerable from APP_CONTEXT, say that this in-app assistant currently focuses on Open Brain household information.

Return JSON only in this exact shape:
{
  "answer": "plain text answer",
  "actions": [
    {
      "type": "task" | "event" | "list_item" | "list_items" | "memory",
      "label": "short button label",
      "payload": {}
    }
  ]
}
Use an empty actions array when no action is proposed. You may return multiple actions when the user asks for multiple distinct reminders/events/memories. Prefer ONE list_items action for multiple items going to the same list.

Action payload schemas:
task: {
  "title": string,
  "description": string|null,
  "assigned_to_user_id": string|null,
  "assigned_to_name": string|null,
  "remind_at": string|null,
  "due_at": string|null,
  "priority": "low"|"normal"|"high"|"urgent",
  "recurrence_rule": string|null,
  "estimated_minutes": integer 1..480|null
}
event: {
  "title": string,
  "description": string|null,
  "location": string|null,
  "starts_at": string|null,
  "ends_at": string|null
}
list_item: {
  "list_id": string|null,
  "list_name": string|null,
  "content": string,
  "quantity": string|null,
  "notes": string|null
}
list_items: {
  "list_id": string|null,
  "list_name": string|null,
  "items": [
    {"content": string, "quantity": string|null, "notes": string|null}
  ]
}
memory: {
  "content": string,
  "visibility": "private"|"household"|"parents",
  "type": "observation"|"task"|"idea"|"reference"|"person_note",
  "topics": string[]
}

For task/event timestamps, use valid ISO-8601 timestamps with an explicit timezone offset whenever the user clearly supplied enough scheduling information. Otherwise use null.
For shopping requests with several items for one list, preserve explicit quantities and return one list_items action rather than many separate list_item actions.
If the user asks for multiple distinct actions, return each one in actions, maximum 12.
Do not include markdown in action payload values.`;

    const modelMessages=[
      {role:"system",content:system},
      {role:"system",content:"APP_CONTEXT:\n"+JSON.stringify(appContext)},
      ...history,
      {role:"user",content:message}
    ];

    const {parsed,model}=await callModel(modelMessages);
    const answer=typeof parsed?.answer==="string"&&parsed.answer.trim()
      ? parsed.answer.trim().slice(0,8000)
      : "I couldn't form a useful answer from the available Open Brain context.";

    const allowedActions=new Set(["task","event","list_item","list_items","memory"]);
    const incomingActions=Array.isArray(parsed?.actions)
      ? parsed.actions
      : (parsed?.action?[parsed.action]:[]);
    const normalized=incomingActions
      .filter((a:any)=>a&&allowedActions.has(a.type)&&a.payload&&typeof a.payload==="object")
      .slice(0,12)
      .map((a:any)=>({
        type:a.type,
        label:typeof a.label==="string"&&a.label.trim()?a.label.trim().slice(0,80):"Review",
        payload:a.payload
      }));

    if(!normalized.length&&!isProposalRevision){
      const shoppingFallback=inferShoppingFallback(message,visibleLists);
      if(shoppingFallback)normalized.push(shoppingFallback);
    }

    const actions:any[]=[];
    const listGroups=new Map<string,any>();
    for(const action of normalized){
      if(action.type==="list_item"||action.type==="list_items"){
        const payload=action.payload||{};
        const key=String(payload.list_id||payload.list_name||"active").trim().toLowerCase();
        let group=listGroups.get(key);
        if(!group){
          group={
            type:"list_items",
            label:"Review items",
            payload:{list_id:payload.list_id||null,list_name:payload.list_name||null,items:[]}
          };
          listGroups.set(key,group);
          actions.push(group);
        }
        const incomingItems=action.type==="list_items"&&Array.isArray(payload.items)
          ? payload.items
          : [{content:payload.content,quantity:payload.quantity||null,notes:payload.notes||null}];
        for(const item of incomingItems){
          const content=String(item?.content||"").trim();
          if(!content)continue;
          const qty=item?.quantity==null?null:String(item.quantity).trim()||null;
          const notes=item?.notes==null?null:String(item.notes).trim()||null;
          const dedupeKey=(content+"|"+(qty||"")).toLowerCase();
          if(!group.payload.items.some((x:any)=>(String(x.content||"")+"|"+String(x.quantity||"")).toLowerCase()===dedupeKey)){
            group.payload.items.push({content,quantity:qty,notes});
          }
        }
      }else{
        actions.push(action);
      }
    }

    for(const action of actions){
      if(action.type==="list_items"){
        const count=Array.isArray(action.payload?.items)?action.payload.items.length:0;
        action.label=count===1?"Review item":`Review ${count} items`;
      }
    }

    const finalActions=actions.slice(0,12);
    return json({
      answer,
      actions:finalActions,
      action:finalActions[0]||null,
      model,
      replace_previous_actions:isProposalRevision&&finalActions.length>0
    });
  }catch(err){
    const message=err instanceof Error?err.message:String(err);
    console.error("Open Brain assistant error:",message);
    return json({error:"Open Brain AI is unavailable right now."},500);
  }
});

Deno.serve((req:Request)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:corsHeaders});
  if(req.method!=="POST")return json({error:"Method not allowed."},405);
  return handler(req);
});
