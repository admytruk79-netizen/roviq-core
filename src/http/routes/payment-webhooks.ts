import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { applyPaymentWebhook, verifyPaymentWebhook } from '../../services/payment-webhook-gateway.js';
import { applyStripeWebhook, verifyStripeWebhook } from '../../services/stripe-webhook.js';

const eventSchema=z.object({
  id:z.string().min(1).max(255),
  type:z.enum(['payment.requires_action','payment.authorized','payment.captured','payment.cancelled','payment.failed','payment.refunded']),
  paymentIntentId:z.string().uuid(),
  amount:z.number().positive().optional(),
  payload:z.record(z.unknown()).optional()
});

const WEBHOOK_BODY_LIMIT=256*1024;

function rawBody(body:unknown){
  if(Buffer.isBuffer(body)) return body.toString('utf8');
  if(typeof body==='string') return body;
  throw new Error('payment_webhook_payload_invalid');
}

function parsedJson(body:unknown){
  const raw=rawBody(body);
  try{return JSON.parse(raw) as unknown;}catch{throw new Error('payment_webhook_payload_invalid');}
}

export async function paymentWebhookRoutes(app:FastifyInstance){
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json',{parseAs:'buffer',bodyLimit:WEBHOOK_BODY_LIMIT},(_req,body,done)=>done(null,body));

  app.post('/api/payments/webhooks/stripe',{config:{public:true},bodyLimit:WEBHOOK_BODY_LIMIT},async(req,reply)=>{
    const body=rawBody(req.body);
    const signature=String(req.headers['stripe-signature']??'');
    try{
      const event=verifyStripeWebhook(body,signature);
      const payment=await applyStripeWebhook(event);
      return {received:true,payment};
    }catch(error){
      const message=error instanceof Error?error.message:'stripe_webhook_error';
      if(['stripe_webhook_not_configured','stripe_webhook_timestamp_invalid','stripe_webhook_signature_invalid'].includes(message)) return reply.code(401).send({error:message});
      if(['stripe_webhook_payload_invalid','stripe_webhook_currency_missing','stripe_currency_unsupported','stripe_currency_precision_unsupported'].includes(message)) return reply.code(400).send({error:message});
      if(message==='payment_not_found'||message==='case_not_found') return reply.code(404).send({error:message});
      if(['stripe_webhook_currency_mismatch','invalid_payment_transition','provider_event_conflict','refund_not_allowed','invalid_refund_amount'].includes(message)) return reply.code(409).send({error:message});
      throw error;
    }
  });

  app.post('/api/payments/webhooks/:provider',{config:{public:true},bodyLimit:WEBHOOK_BODY_LIMIT},async(req,reply)=>{
    const {provider}=z.object({provider:z.string().regex(/^[a-z0-9_-]{1,40}$/i)}).parse(req.params);
    const event=eventSchema.parse(parsedJson(req.body));
    const timestamp=Number(req.headers['x-roviq-webhook-timestamp']);
    const signature=String(req.headers['x-roviq-webhook-signature']??'');
    try{
      verifyPaymentWebhook(provider,timestamp,event,signature);
      const payment=await applyPaymentWebhook(provider,event);
      return {received:true,payment};
    }catch(error){
      const message=error instanceof Error?error.message:'payment_webhook_error';
      if(['payment_webhook_not_configured','payment_webhook_timestamp_invalid','payment_webhook_signature_invalid'].includes(message)) return reply.code(401).send({error:message});
      if(['payment_webhook_amount_required','payment_webhook_payload_invalid'].includes(message)) return reply.code(400).send({error:message});
      if(message==='payment_not_found'||message==='case_not_found') return reply.code(404).send({error:message});
      if(['payment_webhook_provider_mismatch','invalid_payment_transition','provider_event_conflict','refund_not_allowed','invalid_refund_amount'].includes(message)) return reply.code(409).send({error:message});
      throw error;
    }
  });
}
