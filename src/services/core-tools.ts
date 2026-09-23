import type { Principal, RoviqRole } from '../types/principal.js';
import { pool } from '../db/pool.js';
import { loadCoreCaseForPrincipal } from './core-case-access.js';
import { listCoreApprovals, requestCoreApproval } from './core-approvals.js';

export type CoreToolDefinition={
  name:string; description:string; mutates:boolean; roles:readonly RoviqRole[];
};

export const coreToolRegistry:readonly CoreToolDefinition[]=[
  {name:'case.read',description:'Read one authorized Core Case.',mutates:false,roles:['admin','customer','partner','diagnostic','tow','parts','fleet']},
  {name:'approval.list',description:'List approvals for one authorized Core Case.',mutates:false,roles:['admin','customer','partner','diagnostic','tow','parts','fleet']},
  {name:'approval.request',description:'Request an explicit approval for a proposed Core action.',mutates:true,roles:['admin','partner','diagnostic','tow','parts','fleet']}
] as const;

function definition(name:string){return coreToolRegistry.find(t=>t.name===name);}
export async function invokeCoreTool(input:{principal:Principal;toolName:string;args:Record<string,unknown>}){
  const def=definition(input.toolName);if(!def)throw new Error('tool_not_allowed');
  if(!def.roles.includes(input.principal.role))throw new Error('tool_forbidden');
  if(def.mutates&&input.args.confirmed!==true)throw new Error('confirmation_required');
  const caseId=typeof input.args.caseId==='string'?input.args.caseId:null;
  const audit=await pool.query(`insert into core_tool_invocations(case_id,tool_name,principal_role,principal_actor_id,request,outcome)
    values($1,$2,$3,$4,$5,'started') returning id,correlation_id`,
    [caseId,input.toolName,input.principal.role,input.principal.actorId??null,input.args]);
  const invocationId=audit.rows[0].id;
  try{
    let response:unknown;
    if(input.toolName==='case.read'){
      if(!caseId)throw new Error('case_id_required');
      const c=await loadCoreCaseForPrincipal(input.principal,caseId);if(!c)throw new Error('case_not_found');
      response={case:c};
    }else if(input.toolName==='approval.list'){
      if(!caseId)throw new Error('case_id_required');
      response={approvals:await listCoreApprovals(input.principal,caseId)};
    }else if(input.toolName==='approval.request'){
      if(!caseId)throw new Error('case_id_required');
      const approvalType=String(input.args.approvalType??'');
      const action=String(input.args.action??'');
      const requestedFromActorId=String(input.args.requestedFromActorId??'');
      if(!approvalType||!action||!requestedFromActorId)throw new Error('approval_request_invalid');
      response={approval:await requestCoreApproval({
        principal:input.principal,caseId,approvalType,action,requestedFromActorId,
        payload:(input.args.payload&&typeof input.args.payload==='object'&&!Array.isArray(input.args.payload))?input.args.payload as Record<string,unknown>:{}
      })};
    }else throw new Error('tool_not_allowed');
    await pool.query(`update core_tool_invocations set outcome='succeeded',response=$2,completed_at=now() where id=$1`,[invocationId,response]);
    return {invocationId,correlationId:audit.rows[0].correlation_id,response};
  }catch(error){
    const message=error instanceof Error?error.message:String(error);
    const denied=['tool_not_allowed','tool_forbidden','forbidden'].includes(message);
    await pool.query(`update core_tool_invocations set outcome=$2,error=left($3,2000),completed_at=now() where id=$1`,[invocationId,denied?'denied':'failed',message]);
    throw error;
  }
}
