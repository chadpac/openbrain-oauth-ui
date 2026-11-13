export async function readAssistantPreferences(client:any,userId:string){
  const {data,error}=await client.rpc("get_open_brain_assistant_preferences");
  const p=data?.profile;
  if(error || data?.owner_user_id!==userId || !/^[a-f0-9]{64}$/.test(data?.context_version||"") || !p
    || typeof p.assistant_name!=="string" || !p.assistant_name.trim() || p.assistant_name.length>40
    || !["warm","direct","neutral"].includes(p.tone) || !["concise","balanced","detailed"].includes(p.response_length)
    || typeof p.use_saved_memories!=="boolean" || typeof p.working_hours_enabled!=="boolean"
    || typeof p.planning_notes!=="string" || p.planning_notes.length>1500
    || !Array.isArray(p.working_days) || !p.working_days.length || p.working_days.length>7 || new Set(p.working_days).size!==p.working_days.length || p.working_days.some((day:any)=>!Number.isInteger(day)||day<1||day>7)
    || !/^([01]\d|2[0-3]):[0-5]\d$/.test(p.work_start||"") || !/^([01]\d|2[0-3]):[0-5]\d$/.test(p.work_end||"")
    || typeof p.timezone!=="string" || !p.timezone.length || p.timezone.length>80)throw new Error("Assistant settings could not be verified.");
  return {profile:p,context_version:data.context_version};
}
export function assistantStyle(profile:any){
  const tones:any={warm:"Use a warm, calm and practical tone.",direct:"Use a direct, practical tone with minimal preamble.",neutral:"Use a neutral, matter-of-fact tone."};
  const lengths:any={concise:"Keep the answer brief, usually 1–3 short paragraphs.",balanced:"Give a clear answer with the useful supporting detail, usually under 300 words.",detailed:"Give a fuller explanation when useful, usually under 700 words."};
  return tones[profile.tone]+" "+lengths[profile.response_length];
}

export function assistantProfileContext(p:any){
  return {assistant_name:p.assistant_name,tone:p.tone,response_length:p.response_length,planning_notes:p.planning_notes,use_saved_memories:p.use_saved_memories,working_hours:p.working_hours_enabled?{start:p.work_start,end:p.work_end,days:p.working_days,timezone:p.timezone}:null};
}
