import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';

type Queryable=Pick<PoolClient,'query'>;
type Decision='allow'|'deny'|'require_review';

type Rule={
  id:string; policy_code:string; action:string; effect:Decision; priority:number;
  case_type:string|null; from_state:string|null; to_state:string|null; actor_role:string|null;
  predicate:Record<string,unknown>; reason:string;
};

function getPath(source:unknown,path:string){
  let current:unknown=source;
  for(const part of path.split('.')){
    if(!current||typeof current!=='object'||Array.isArray(current))return undefined;
    current=(current as Record<string,unknown>)[part];
  }
  return current;
}
function equal(a:unknown,b:unknown){return JSON.stringify(a)===JSON.stringify(b);}
function predicateMatches(predicate:Record<string,unknown>,facts:Record<string,unknown>){
  for(const [path,condition] of Object.entries(predicate)){
    const actual=getPath(facts,path);
    if(condition&&typeof condition==='object'&&!Array.isArray(condition)){
      const c=condition as Record<string,unknown>;
      if('eq' in c&&!equal(actual,c.eq))return false;
      if('neq' in c&&equal(actual,c.neq))return false;
      if('exists' in c&&Boolean(c.exists)!==(actual!==undefined&&actual!==null))return false;
      if('in' in c){
        if(!Array.isArray(c.in)||!c.in.some(v=>equal(v,actual)))return false;
      }
      if('contains' in c){
        if(!Array.isArray(actual)||!actual.some(v=>equal(v,c.contains)))return false;
      }
    }else if(!equal(actual,condition))return false;
  }
  return true;
}

export async function evaluateCorePolicy(input:{
  action:string; principal:Principal; caseRecord?:Record<string,any>|null;
  toState?:string; facts?:Record<string,unknown>;
},db:Queryable=pool){
  const c=input.caseRecord??null;
  const facts:Record<string,unknown>={
    case:{id:c?.id??null,type:c?.case_type??null,state:c?.state??null,priority:c?.priority??null,
      constraints:c?.constraints??{},requirements:c?.requirements??{},attributes:c?.attributes??{}},
    actor:{id:input.principal.actorId??null,role:input.principal.role},
    transition:{to:input.toState??null},
    ...(input.facts??{})
  };
  const r=await db.query<Rule>(`select * from core_policy_rules
    where enabled=true and (action=$1 or action='*')
      and (case_type is null or case_type=$2)
      and (from_state is null or from_state=$3)
      and (to_state is null or to_state=$4)
      and (actor_role is null or actor_role=$5)
    order by priority desc,created_at,id`,
    [input.action,c?.case_type??null,c?.state??null,input.toState??null,input.principal.role]);
  const matched=r.rows.filter(rule=>predicateMatches(rule.predicate??{},facts));
  let decision:Decision='allow';
  if(matched.some(x=>x.effect==='deny'))decision='deny';
  else if(matched.some(x=>x.effect==='require_review'))decision='require_review';
  const decisive=matched.find(x=>x.effect===decision);
  const reason=decisive?.reason??'No blocking policy matched';
  await db.query(`insert into core_policy_decisions(case_id,action,decision,actor_id,actor_role,matched_rule_ids,reason,facts)
    values($1,$2,$3,$4,$5,$6,$7,$8)`,
    [c?.id??null,input.action,decision,input.principal.actorId??null,input.principal.role,matched.map(x=>x.id),reason,facts]);
  return {decision,reason,matchedRules:matched.map(x=>({id:x.id,code:x.policy_code,effect:x.effect,reason:x.reason}))};
}
