import Fastify from 'fastify';
import { getConfig, requireSecret } from '@reg/config';
import { updateBotChat, upsertMaxIdentity } from '@reg/db';
import { buildMiniAppDeepLink, MaxApiClient } from '@reg/max';

const config = getConfig();
const app = Fastify({ logger: true });

const client = config.MAX_BOT_TOKEN
  ? new MaxApiClient({ apiBaseUrl: config.MAX_API_BASE_URL, botToken: config.MAX_BOT_TOKEN })
  : null;

app.get('/health', async () => ({ status: 'ok', service: 'bot', maxConfigured: Boolean(client) }));

app.post('/webhook', async (request, reply) => {
  if (config.MAX_WEBHOOK_SECRET) {
    const received = request.headers['x-max-bot-api-secret'];
    if (received !== config.MAX_WEBHOOK_SECRET) return reply.code(401).send({ error: 'INVALID_WEBHOOK_SECRET' });
  }
  const update = request.body as any;
  const updateType = String(update?.update_type ?? '');
  const user = update?.user;
  const chatId = update?.chat_id != null ? String(update.chat_id) : null;

  if (user?.user_id != null) {
    const identity = await upsertMaxIdentity({ user, chatId });
    if (updateType === 'bot_stopped' || updateType === 'dialog_removed') {
      await updateBotChat({ maxUserId: identity.maxUserId, chatId, active: false });
    }
    if (updateType === 'bot_started' && client) {
      const payload = typeof update.payload === 'string' && update.payload ? update.payload : 'home';
      const link = config.MAX_BOT_USERNAME
        ? buildMiniAppDeepLink(config.MAX_BOT_USERNAME, payload)
        : config.MAX_MINI_APP_URL;
      await client.sendMessageToUser({
        userId: identity.maxUserId,
        text: 'Регуляторный контроль готов. Откройте мини-приложение, заполните профиль компании и получите только те изменения, которые относятся к вашему бизнесу.',
        button: link ? { text: 'Открыть приложение', url: link } : undefined,
      });
    }
  }

  return { ok: true };
});

await app.listen({ port: config.BOT_PORT, host: config.BOT_HOST });
