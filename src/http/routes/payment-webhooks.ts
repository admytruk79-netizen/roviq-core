import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { applyPaymentWebhook, verifyPaymentWebhook } from '../../services/payment-webhook-gateway.js';

const eventSchema=z.object({
  id:z.string().min(1).max(255),
  type:z.enum(['payment.requires_action','payment.authorized','payment.captured','payment.cancelled','payment.failed','payment.refunded']),
  paymentIntentId:z.string().uuid(),
  amount:z.number().positive().optional(),
  payload:z.record(z.unknown()).optional()
});

export async function paymentWebhookRoutes(app:FastifyInstance){
  app.post('/api/payments/webhooks/:provider',{config:{public:true}},async(req,reply)=>{
    const {provider}=z.object({provider:z.string().regex(/^[a-z0-9_-]{1,40}$/i)}).parse(req.params);
    const event=eventSchema.parse(req.body);
    const timestamp=Number(req.headers['x-roviq-webhook-timestamp']);
    const signature=String(req.headers['x-roviq-webhook-signature']??'');
    try{
      verifyPaymentWebhook(provider,timestamp,event,signature);
      const payment=await applyPaymentWebhook(provider,event);
      return {received:true,payment};
    }catch(error){
      const message=error instanceof Error?error.message:'payment_webhook_error';
      if(['payment_webhook_not_configured','payment_webhook_timestamp_invalid','payment_webhook_signature_invalid'].includes(message)) return reply.code(401).send({error:message});
      if(message==='payment_webhook_amount_required') return reply.code(400).send({error:message});
      if(message==='payment_not_found'||message==='case_not_found') return reply.code(404).send({error:message});
      if(['invalid_payment_transition','provider_event_conflict','refund_not_allowed','invalid_refund_amount'].includes(message)) return reply.code(409).send({error:message});
      throw error;
    }
  });
}
