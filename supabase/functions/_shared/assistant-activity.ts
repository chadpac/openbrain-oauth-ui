// Server-only lifecycle writes. User data and approval saves use the caller's RLS client.
export async function activityCommand(owner:string,id:string,command:string,version:number|null=null,result:any={}){
  const response=await fetch(Deno.env.get("SUPABASE_URL")+"/rest/v1/rpc/control_open_brain_activity",{
    method:"POST",headers:{"Content-Type":"application/json",apikey:Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,Authorization:"Bearer "+Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!},
    body:JSON.stringify({p_owner:owner,p_id:id,p_command:command,p_version:version,p_result:result}),signal:AbortSignal.timeout(15000)
  });
  if(!response.ok)throw new Error("Activity changed or could not be confirmed. Refresh Activity.");
  return await response.json();
}

export function prepareActivityActions(actions:any[],context:any){
  return actions.slice(0,12).map(action=>{
    const p=action.payload||{},me=context.signed_in_person;
    const text=(value:any,max=4000)=>typeof value==="string"?value.trim().slice(0,max):null;
    const date=(value:any)=>typeof value==="string"&&/(Z|[+-]\d\d:\d\d)$/.test(value)&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
    let payload:any={},blocked:string|null=null;
    if(action.type==="task"){
      const member=(context.family_members||[]).find((m:any)=>m.user_id===(p.assigned_to_user_id||me.user_id));
      if(!member||(member.user_id!==me.user_id&&me.role!=="admin"))blocked="Choose an allowed assignee in a new request.";
      payload={title:text(p.title,500),description:text(p.description),assigned_to_user_id:member?.user_id||me.user_id,assigned_to:member?.display_name||me.display_name,visibility:me.role==="admin"?"household":"private",priority:["low","normal","high","urgent"].includes(p.priority)?p.priority:"normal",remind_at:date(p.remind_at),due_at:date(p.due_at),recurrence_rule:text(p.recurrence_rule,300),estimated_minutes:Number.isInteger(p.estimated_minutes)&&p.estimated_minutes>=1&&p.estimated_minutes<=480?p.estimated_minutes:null};
      if(!payload.title||!payload.remind_at)blocked="Ask again with a title and reminder time before approval.";
      if(payload.recurrence_rule){
        payload.recurrence_rule=payload.recurrence_rule.toLowerCase();
        const rule=payload.recurrence_rule;
        const valid=/^(daily|weekly|monthly|weekdays)$/.test(rule)||/^(days|weeks|months):[1-9][0-9]{0,3}$/.test(rule)||/^weekdays:(sun|mon|tue|wed|thu|fri|sat)(,(sun|mon|tue|wed|thu|fri|sat))*$/.test(rule);
        if(!valid)blocked="Ask again with an Open Brain recurrence rule, such as daily or weekdays:mon,wed,fri.";
      }
    }else if(action.type==="event"){
      payload={title:text(p.title,500),description:text(p.description),location:text(p.location,1000),starts_at:date(p.starts_at),ends_at:date(p.ends_at),visibility:"household"};
      if(!payload.title||!payload.starts_at||(payload.ends_at&&payload.ends_at<=payload.starts_at))blocked="Ask again with a title and valid start/end times.";
    }else if(action.type==="memory"){
      payload={content:text(p.content,12000),visibility:["private","household","parents"].includes(p.visibility)?p.visibility:"private",type:["observation","task","idea","reference","person_note"].includes(p.type)?p.type:"reference",topics:Array.isArray(p.topics)?p.topics.filter((v:any)=>typeof v==="string").slice(0,12).map((v:string)=>v.slice(0,80)):[]};
      if(!payload.content)blocked="Ask again with the memory text.";
      if(payload.visibility==="parents"&&me.role!=="admin")blocked="Parents-only memories require a household administrator.";
    }else{
      const name=text(p.list_name,200)?.toLowerCase();
      const matches=(context.lists||[]).filter((l:any)=>p.list_id?l.id===p.list_id:name?l.name.toLowerCase()===name:false);
      const list=matches.length===1?matches[0]:null;
      const incoming=action.type==="list_items"?p.items:[p];
      payload={list_id:list?.id||null,list_name:list?.name||text(p.list_name,200),visibility:list?.visibility||null,items:(Array.isArray(incoming)?incoming:[]).slice(0,50).map((i:any)=>({content:text(i?.content,1000),quantity:text(i?.quantity,100),notes:text(i?.notes,2000)})).filter((i:any)=>i.content)};
      if(!list||!payload.items.length)blocked="Name one accessible, active list and at least one item in a new request.";
    }
    return {type:action.type==="list_item"?"list_items":action.type,label:text(action.label,80)||"Review",payload,blocked};
  });
}
