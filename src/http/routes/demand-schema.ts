import { z } from 'zod';

const requestedServiceAtSchema = z.string().datetime();

export const createDemandSchema = z.object({
  domain: z.string().default('maintenance'),
  demandType: z.string().min(1),
  location: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).optional(),
  urgency: z.enum(['normal','urgent','emergency']).default('normal'),
  requestedServiceAt: requestedServiceAtSchema.optional(),
  attributes: z.record(z.unknown()).default({})
}).superRefine((value,ctx)=>{
  const legacy=value.attributes.requestedServiceAt;
  if(legacy===undefined)return;
  const parsed=requestedServiceAtSchema.safeParse(legacy);
  if(!parsed.success){
    ctx.addIssue({code:z.ZodIssueCode.custom,path:['attributes','requestedServiceAt'],message:'Invalid datetime'});
    return;
  }
  if(value.requestedServiceAt!==undefined&&value.requestedServiceAt!==parsed.data){
    ctx.addIssue({code:z.ZodIssueCode.custom,path:['requestedServiceAt'],message:'Conflicts with attributes.requestedServiceAt'});
  }
}).transform((value)=>{
  const legacy=value.attributes.requestedServiceAt;
  const canonical=value.requestedServiceAt ?? (typeof legacy==='string'?legacy:undefined);
  const {requestedServiceAt:_legacyRequestedServiceAt,...attributes}=value.attributes;
  return {...value,requestedServiceAt:canonical,attributes};
});
