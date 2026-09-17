import { getConfig, requireSecret } from '@reg/config';
import { MaxApiClient } from '@reg/max';

const config = getConfig();
const client = new MaxApiClient({
  apiBaseUrl: config.MAX_API_BASE_URL,
  botToken: requireSecret(config.MAX_BOT_TOKEN, 'MAX_BOT_TOKEN'),
});
const result = await client.subscribe({
  url: requireSecret(config.MAX_WEBHOOK_URL, 'MAX_WEBHOOK_URL'),
  secret: config.MAX_WEBHOOK_SECRET,
  updateTypes: ['bot_started', 'bot_stopped', 'message_created', 'message_callback', 'dialog_removed'],
});
console.log(JSON.stringify(result, null, 2));
