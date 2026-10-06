export type Constraint<T=unknown>={id:string;hard:boolean;evaluate:(state:T)=>{pass:boolean;reason?:string}};
export type Candidate<T>={state:T;reasons:string[]};
export function feasibleSet<T>(states:T[],constraints:Constraint<T>[]):Candidate<T>[]{
 return states.map(state=>({state,reasons:constraints.flatMap(c=>{const r=c.evaluate(state);return r.pass?[]:[r.reason??c.id]})}))
 .filter(x=>x.reasons.length===0);
}
export function checksumInput(value:unknown):string{return JSON.stringify(value);}
