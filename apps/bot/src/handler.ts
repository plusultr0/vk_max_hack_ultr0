import { z } from 'zod';
import type { AppConfig } from '@reg/config';
import {
  claimBotInteractionEvent,
  releaseBotInteractionEvent,
  getProfileState,
  complianceBaseline,
  listBusinessChecks,
  personalizedRegulatoryFeed,
  updateActionStatus,
} from '@reg/db';
import { callbackButton, openMiniAppButton, type MaxApiClient, type MaxButtonRows } from '@reg/max';
import {
  detectIntent, menuMessage, mainMenuButtons, helpMessage, appMessage, unknownMessage, groupPrivacyMessage,
  profileNeededMessage, statusMessage, requirementsMessage, actionsMessage, actionButtons, changesMessage,
  documentsMessage, historyMessage, searchRequirements, searchMessage, searchButtons,
  openActions, actionConfirmation, sectionButtons, type BotIntent,
} from './scenarios.js';

const UserSchema=z.object({
  user_id:z.union([z.number(),z.string()]),first_name:z.string().optional(),last_name:z.string().nullable().optional(),
  username:z.string().nullable().optional(),is_bot:z.boolean().optional(),
}).passthrough();
const RecipientSchema=z.object({
  chat_id:z.union([z.number(),z.string()]).nullable().optional(),
  chat_type:z.enum(['dialog','chat','channel']).optional(),user_id:z.union([z.number(),z.string()]).nullable().optional(),
}).passthrough();
const MessageSchema=z.object({
  sender:UserSchema.optional(),recipient:RecipientSchema,
  timestamp:z.number().int().nonnegative(),
  // MAX may omit body for a message that only forwards another message.
  body:z.object({mid:z.string().min(1),text:z.string().nullable().optional(),attachments:z.array(z.unknown()).nullable().optional()}).passthrough().nullable().optional(),
}).passthrough();
export const MessageCreatedSchema=z.object({update_type:z.literal('message_created'),timestamp:z.number().int().nonnegative(),message:MessageSchema}).passthrough();
export const MessageCallbackSchema=z.object({
  update_type:z.literal('message_callback'),timestamp:z.number().int().nonnegative(),
  callback:z.object({timestamp:z.number().int().nonnegative(),callback_id:z.string().min(1),payload:z.string().optional(),user:UserSchema}).passthrough(),
  message:MessageSchema.nullable().optional(),
}).passthrough();

function companyId(userId:string){return 'company-max-'+userId;}
function botUsername(config:AppConfig){return config.MAX_BOT_USERNAME??'';}
function directChatType(message:z.infer<typeof MessageSchema>|null|undefined){return message?.recipient.chat_type??'dialog';}
function chatId(message:z.infer<typeof MessageSchema>|null|undefined){const id=message?.recipient.chat_id;return id==null?null:String(id);}

async function loadPersonalContext(userId:string) {
  const id=companyId(userId),profile=await getProfileState(id);
  return {companyId:id,profile};
}

async function renderIntent(intent:BotIntent,userId:string,config:AppConfig,firstName?:string|null,query?:string|null) {
  const username=botUsername(config);
  if(intent==='start'||intent==='menu')return {text:menuMessage(firstName),buttons:mainMenuButtons(username)};
  if(intent==='help')return {text:helpMessage(),buttons:sectionButtons(username,'home','Открыть Mini App')};
  if(intent==='app')return {text:appMessage(),buttons:sectionButtons(username,'home','Открыть Mini App')};
  if(intent==='profile')return {text:'Профиль бизнеса открывается в Mini App. Там можно изменить ответы и запустить новый пересчёт.',buttons:sectionButtons(username,'profile','Открыть профиль')};
  if(intent==='history')return {text:historyMessage(),buttons:sectionButtons(username,'history','Открыть историю')};
  const context=await loadPersonalContext(userId);
  if(!context.profile.confirmed)return {text:profileNeededMessage(context.profile.progress),buttons:sectionButtons(username,'profile','Заполнить профиль')};
  if(intent==='unknown') {
    const baseline=await complianceBaseline(context.companyId);
    const matches=searchRequirements(baseline,query??'');
    return matches.length
      ? {text:searchMessage(matches),buttons:searchButtons(username,matches)}
      : {text:unknownMessage(),buttons:mainMenuButtons(username)};
  }
  if(intent==='status') {
    const baseline=await complianceBaseline(context.companyId);
    return {text:statusMessage(baseline),buttons:[
      [openMiniAppButton(username,'Открыть проверку','check')],
      [callbackButton('Требования','nav:requirements'),callbackButton('Действия','nav:actions')],
      [callbackButton('← Меню','nav:menu')],
    ] satisfies MaxButtonRows};
  }
  if(intent==='requirements') {
    const baseline=await complianceBaseline(context.companyId);
    return {text:requirementsMessage(baseline),buttons:sectionButtons(username,'check','Открыть требования')};
  }
  if(intent==='actions') {
    const baseline=await complianceBaseline(context.companyId);
    return {text:actionsMessage(baseline),buttons:actionButtons(username,baseline)};
  }
  if(intent==='changes') {
    const feed=await personalizedRegulatoryFeed(context.companyId,{filter:'new_relevant',limit:5});
    return {text:changesMessage(feed),buttons:sectionButtons(username,'feed','Открыть изменения')};
  }
  if(intent==='documents') {
    const checks=await listBusinessChecks(context.companyId);
    return {text:documentsMessage(checks),buttons:sectionButtons(username,'documents','Открыть документы')};
  }
  return {text:unknownMessage(),buttons:mainMenuButtons(username)};
}

async function sendDirect(client:MaxApiClient,userId:string,result:{text:string;buttons?:MaxButtonRows}) {
  return client.sendMessageToUser({userId,text:result.text,buttons:result.buttons});
}

async function handleMessage(update:unknown,client:MaxApiClient,config:AppConfig) {
  const parsed=MessageCreatedSchema.parse(update),sender=parsed.message.sender;
  if(!sender||sender.is_bot)return {ok:true,ignored:true,reason:'NO_HUMAN_SENDER'};
  const userId=String(sender.user_id),group=directChatType(parsed.message)!=='dialog';
  const intent=detectIntent(parsed.message.body?.text);
  if(group) {
    // Never disclose a person's business status into a group. Unknown group chatter is ignored to avoid bot spam.
    if(intent==='unknown')return {ok:true,ignored:true,reason:'GROUP_NON_COMMAND'};
    const id=chatId(parsed.message);
    if(id)await client.sendMessageToChat({chatId:id,text:groupPrivacyMessage(),buttons:[[openMiniAppButton(botUsername(config),'Открыть бота','home')]]});
    return {ok:true,groupGuard:true};
  }
  const claim=await claimBotInteractionEvent(update,{updateType:'message_created',userId,firstName:sender.first_name,lastName:sender.last_name,
    username:sender.username,chatId:chatId(parsed.message),rawUser:sender});
  if(claim.duplicate)return {ok:true,duplicate:true};
  try {
    const result=await renderIntent(intent,userId,config,sender.first_name,parsed.message.body?.text);
    await sendDirect(client,userId,result);
    return {ok:true,intent};
  } catch(error) {
    await releaseBotInteractionEvent(claim.eventKey).catch(()=>undefined);
    throw error;
  }
}

async function findAction(company:string,actionId:string) {
  const baseline=await complianceBaseline(company);
  const entry=openActions(baseline).find(item=>item.action.id===actionId);
  return {baseline,entry};
}

async function handleCallback(update:unknown,client:MaxApiClient,config:AppConfig) {
  const parsed=MessageCallbackSchema.parse(update),user=parsed.callback.user,userId=String(user.user_id);
  if(!parsed.message||directChatType(parsed.message)!=='dialog') {
    await client.answerCallback({callbackId:parsed.callback.callback_id,notification:'Персональные данные доступны только в личном диалоге с ботом.'});
    return {ok:true,groupGuard:true};
  }
  const claim=await claimBotInteractionEvent(update,{updateType:'message_callback',userId,firstName:user.first_name,lastName:user.last_name,
    username:user.username,chatId:chatId(parsed.message),rawUser:user});
  if(claim.duplicate)return {ok:true,duplicate:true};
  try {
    const payload=parsed.callback.payload??'';
    if(payload.startsWith('nav:')) {
      const name=payload.slice(4);
      const allowed=new Set<BotIntent>(['menu','status','requirements','actions','changes','documents','history','help','app','profile']);
      const intent=allowed.has(name as BotIntent)?name as BotIntent:'menu';
      const result=await renderIntent(intent,userId,config,user.first_name);
      await client.answerCallback({callbackId:parsed.callback.callback_id,text:result.text,buttons:result.buttons});
      return {ok:true,callback:intent};
    }
    const ask=payload.match(/^action:ask:([A-Za-z0-9-]+)$/);
    if(ask) {
      const profile=await getProfileState(claim.companyId);
      if(!profile.confirmed){
        await client.answerCallback({callbackId:parsed.callback.callback_id,text:profileNeededMessage(profile.progress),buttons:sectionButtons(botUsername(config),'profile','Заполнить профиль')});
        return {ok:true,callback:'action_profile_needed'};
      }
      const {entry}=await findAction(claim.companyId,ask[1]!);
      if(!entry){
        await client.answerCallback({callbackId:parsed.callback.callback_id,notification:'Действие уже выполнено или больше не актуально.'});
        return {ok:true,callback:'action_not_current'};
      }
      await client.answerCallback({callbackId:parsed.callback.callback_id,text:actionConfirmation(entry.action.title,entry.action.deadline),buttons:[
        [callbackButton('Подтвердить',`action:done:${entry.action.id}`),callbackButton('Отмена','nav:actions')],
        [openMiniAppButton(botUsername(config),'Открыть карточку',`assessment_${entry.impact.id}`)],
      ]});
      return {ok:true,callback:'action_confirm'};
    }
    const done=payload.match(/^action:done:([A-Za-z0-9-]+)$/);
    if(done) {
      const current=await findAction(claim.companyId,done[1]!);
      if(!current.entry){
        await client.answerCallback({callbackId:parsed.callback.callback_id,notification:'Действие уже выполнено или больше не актуально.'});
        return {ok:true,callback:'action_already_done'};
      }
      const changed=await updateActionStatus({companyId:claim.companyId,actionId:done[1]!,status:'completed',actorId:userId});
      if(!changed){
        await client.answerCallback({callbackId:parsed.callback.callback_id,notification:'Действие не найдено.'});
        return {ok:true,callback:'action_missing'};
      }
      const result=await renderIntent('actions',userId,config,user.first_name);
      await client.answerCallback({callbackId:parsed.callback.callback_id,text:`Готово. Действие отмечено выполненным.\n\n${result.text}`,buttons:result.buttons});
      return {ok:true,callback:'action_completed'};
    }
    const menu=await renderIntent('menu',userId,config,user.first_name);
    await client.answerCallback({callbackId:parsed.callback.callback_id,text:'Эта кнопка устарела. Показываю актуальное меню.\n\n'+menu.text,buttons:menu.buttons});
    return {ok:true,callback:'unknown'};
  } catch(error) {
    await releaseBotInteractionEvent(claim.eventKey).catch(()=>undefined);
    if(error instanceof Error&&error.message==='STALE_ACTION') {
      await client.answerCallback({callbackId:parsed.callback.callback_id,notification:'Требование обновилось. Откройте карточку и проверьте действие заново.'}).catch(()=>undefined);
      return {ok:true,callback:'stale_action'};
    }
    throw error;
  }
}

export function createBotUpdateHandler(input:{client:MaxApiClient;config:AppConfig}) {
  return async (update:unknown) => {
    const kind=(update as any)?.update_type;
    if(kind==='message_created')return handleMessage(update,input.client,input.config);
    if(kind==='message_callback')return handleCallback(update,input.client,input.config);
    return {ok:true,ignored:true};
  };
}
