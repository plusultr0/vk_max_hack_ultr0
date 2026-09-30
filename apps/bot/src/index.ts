import Fastify from 'fastify';
import { z } from 'zod';
import { getConfig } from '@reg/config';
import { acceptBotEvent } from '@reg/db';
import { constantTimeEqual, MaxApiClient } from '@reg/max';
import { createBotUpdateHandler } from './handler.js';

const config=getConfig();
if(config.NODE_ENV==='production' && !config.MAX_WEBHOOK_SECRET)throw new Error('MAX_WEBHOOK_SECRET_REQUIRED');
const app=Fastify({logger:true,bodyLimit:100000});
const client=config.MAX_BOT_TOKEN?new MaxApiClient({apiBaseUrl:config.MAX_API_BASE_URL,botToken:config.MAX_BOT_TOKEN}):null;
const handleInteractive=client?createBotUpdateHandler({client,config}):null;

app.get('/health',async()=>({
  status:'ok',service:'bot',maxConfigured:Boolean(config.MAX_BOT_TOKEN),miniAppConfigured:Boolean(config.MAX_BOT_TOKEN&&config.MAX_BOT_USERNAME),
}));

app.post('/webhook',async(request,reply)=>{
  if(!config.MAX_WEBHOOK_SECRET || !constantTimeEqual(request.headers['x-max-bot-api-secret'],config.MAX_WEBHOOK_SECRET))
    return reply.code(401).send({error:'INVALID_WEBHOOK_SECRET'});
  const kind=(request.body as any)?.update_type;
  try {
    if(['bot_started','bot_stopped','dialog_removed'].includes(kind))return await acceptBotEvent(request.body);
    if(['message_created','message_callback'].includes(kind)) {
      if(!handleInteractive)return reply.code(503).send({error:'MAX_NOT_CONFIGURED'});
      return await handleInteractive(request.body);
    }
    return {ok:true,ignored:true};
  } catch(error) {
    if(error instanceof z.ZodError)return reply.code(400).send({error:'INVALID_MAX_EVENT'});
    throw error;
  }
});
await app.listen({port:config.BOT_PORT,host:config.BOT_HOST});
