// Scheduler credentials remain inside Vault; browser clients cannot call this RPC.
export async function authorizeScheduler(req:Request,admin:any){
  if(req.method!=="POST")return Response.json({error:"Method not allowed."},{status:405});
  const token=(req.headers.get("Authorization")||"").replace(/^Bearer\s+/i,"");
  if(token.length<32||token.length>128)return Response.json({error:"Unauthorized."},{status:401});
  const {data,error}=await admin.rpc("authorize_open_brain_scheduler",{p_token:token});
  if(error)return Response.json({error:"Scheduler authentication unavailable."},{status:503});
  if(data!==true)return Response.json({error:"Unauthorized."},{status:401});
  return null;
}

export async function claimReminder(admin:any,key:string){
  const {data,error}=await admin.rpc("claim_open_brain_reminder",{p_key:key});
  if(error)throw new Error("Unable to claim reminder delivery.");
  return data as {claimed:boolean;sent:boolean;lease_id:string|null;attempts:number;sent_at?:string;last_error?:string};
}

export async function finishReminder(admin:any,key:string,leaseId:string,sent:boolean,errorMessage:string|null=null){
  const {data,error}=await admin.rpc("finish_open_brain_reminder",{
    p_key:key,p_lease_id:leaseId,p_sent:sent,p_error:errorMessage?.slice(0,500)||null
  });
  if(error||data!==true)throw new Error("Unable to record reminder delivery.");
}
