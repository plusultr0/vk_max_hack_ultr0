import { getConfig, requireSecret } from '@reg/config';
import { MaxApiClient } from '@reg/max';
import { BOT_COMMANDS } from './scenarios.js';

const config = getConfig();
const client = new MaxApiClient({
  apiBaseUrl: config.MAX_API_BASE_URL,
  botToken: requireSecret(config.MAX_BOT_TOKEN, 'MAX_BOT_TOKEN'),
});
const subscription = await client.subscribe({
  url: requireSecret(config.MAX_WEBHOOK_URL, 'MAX_WEBHOOK_URL'),
  secret: config.MAX_WEBHOOK_SECRET,
  updateTypes: ['bot_started', 'bot_stopped', 'message_created', 'message_callback', 'dialog_removed'],
});
const commands = await client.setCommands(BOT_COMMANDS);
console.log(JSON.stringify({ subscription, commands }, null, 2));
