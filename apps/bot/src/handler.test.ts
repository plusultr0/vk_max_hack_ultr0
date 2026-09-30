import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@reg/config';
import type { MaxApiClient } from '@reg/max';

vi.mock('@reg/db', () => ({
  claimBotInteractionEvent: vi.fn(),
  releaseBotInteractionEvent: vi.fn(),
  getProfileState: vi.fn(),
  complianceBaseline: vi.fn(),
  listBusinessChecks: vi.fn(),
  personalizedRegulatoryFeed: vi.fn(),
  updateActionStatus: vi.fn(),
}));

import * as db from '@reg/db';
import { createBotUpdateHandler } from './handler.js';

const config={MAX_BOT_USERNAME:'t106_hakaton_max_bot'} as AppConfig;
const confirmedProfile={confirmed:{profileVersion:1},draft:{},progress:{answered:6,total:6,percent:100,canConfirm:true,missing:[]}};
const emptyBaseline={summary:{actionRequired:0,needsInfo:0,verify:0,selfReportedCompleted:0},coverage:{activeRulesAssessed:37},items:[],refreshPending:false};

function directMessage(text:string,mid='m1') {
  return {update_type:'message_created',timestamp:100,message:{
    sender:{user_id:42,first_name:'Макс'},recipient:{chat_id:42,chat_type:'dialog',user_id:42},timestamp:100,
    body:{mid,text,attachments:[]},
  }};
}

function callback(payload:string) {
  return {update_type:'message_callback',timestamp:101,callback:{timestamp:101,callback_id:'cb-1',payload,user:{user_id:42,first_name:'Макс'}},message:{
    recipient:{chat_id:42,chat_type:'dialog',user_id:42},timestamp:100,body:{mid:'bot-message',text:'menu',attachments:[]},
  }};
}

function client() {
  return {
    sendMessageToUser:vi.fn().mockResolvedValue({ok:true}),sendMessageToChat:vi.fn().mockResolvedValue({ok:true}),
    answerCallback:vi.fn().mockResolvedValue({ok:true}),
  } as unknown as MaxApiClient & {sendMessageToUser:ReturnType<typeof vi.fn>;sendMessageToChat:ReturnType<typeof vi.fn>;answerCallback:ReturnType<typeof vi.fn>};
}

beforeEach(()=>{
  vi.clearAllMocks();
  vi.mocked(db.claimBotInteractionEvent).mockResolvedValue({eventKey:'event-1',companyId:'company-max-42',duplicate:false});
  vi.mocked(db.releaseBotInteractionEvent).mockResolvedValue(undefined);
  vi.mocked(db.getProfileState).mockResolvedValue(confirmedProfile as any);
  vi.mocked(db.complianceBaseline).mockResolvedValue(emptyBaseline as any);
  vi.mocked(db.listBusinessChecks).mockResolvedValue({items:[],summary:{total:0,present:0,missing:0,clarify:0,unknown:0,unchecked:0,upcoming:0},refreshPending:false,coverage:{}} as any);
  vi.mocked(db.personalizedRegulatoryFeed).mockResolvedValue({items:[],total:0,nextOffset:null} as any);
});

describe('MAX chatbot webhook handler',()=>{
  it('filters /changes to recent relevant requirements',async()=>{
    const max=client(),handle=createBotUpdateHandler({client:max,config});
    await handle(directMessage('/changes'));
    expect(db.personalizedRegulatoryFeed).toHaveBeenCalledWith('company-max-42',{filter:'new_relevant',limit:5});
  });

  it('answers /status from the calculated company baseline',async()=>{
    const max=client(),handle=createBotUpdateHandler({client:max,config});
    await handle(directMessage('/status'));
    expect(db.complianceBaseline).toHaveBeenCalledWith('company-max-42');
    expect(max.sendMessageToUser).toHaveBeenCalledWith(expect.objectContaining({userId:'42',text:expect.stringContaining('Статус по загруженным требованиям')}));
  });

  it('sends an unfinished user back to the profile instead of inventing a result',async()=>{
    vi.mocked(db.getProfileState).mockResolvedValue({confirmed:null,draft:{},progress:{answered:3,total:6,percent:50,canConfirm:false,missing:[]}} as any);
    const max=client(),handle=createBotUpdateHandler({client:max,config});
    await handle(directMessage('что мне нужно сделать'));
    expect(max.sendMessageToUser).toHaveBeenCalledWith(expect.objectContaining({text:expect.stringContaining('Профиль бизнеса ещё не подтверждён')}));
    expect(db.complianceBaseline).not.toHaveBeenCalled();
  });

  it('searches verified personal requirements for free text and does not call an LLM',async()=>{
    vi.mocked(db.complianceBaseline).mockResolvedValue({...emptyBaseline,items:[{
      id:'impact-pd',ruleId:'pd',verdict:'applies',complianceState:'unknown',questions:[],actions:[],
      rule:{userTitle:'Уведомление Роскомнадзора об обработке персональных данных',summary:'Персональные данные клиентов'},
    }]} as any);
    const max=client(),handle=createBotUpdateHandler({client:max,config});
    await handle(directMessage('что у меня по персональным данным?'));
    expect(max.sendMessageToUser).toHaveBeenCalledWith(expect.objectContaining({text:expect.stringContaining('Роскомнадзора')}));
  });

  it('does not duplicate a retried MAX message',async()=>{
    vi.mocked(db.claimBotInteractionEvent).mockResolvedValue({eventKey:'event-1',companyId:'company-max-42',duplicate:true});
    const max=client(),handle=createBotUpdateHandler({client:max,config});
    expect(await handle(directMessage('/menu'))).toMatchObject({duplicate:true});
    expect(max.sendMessageToUser).not.toHaveBeenCalled();
  });

  it('never exposes personal status in a group chat',async()=>{
    const max=client(),handle=createBotUpdateHandler({client:max,config});
    const event=directMessage('/status');event.message.recipient.chat_type='chat';event.message.recipient.chat_id=777;
    await handle(event);
    expect(max.sendMessageToChat).toHaveBeenCalledWith(expect.objectContaining({chatId:'777',text:expect.stringContaining('не показываю в групповых чатах')}));
    expect(db.complianceBaseline).not.toHaveBeenCalled();
  });

  it('confirms and completes a current action from a callback',async()=>{
    const baseline={...emptyBaseline,items:[{id:'impact-1',ruleId:'rule-1',complianceState:'action_required',questions:[],rule:{userTitle:'Требование'},actions:[
      {id:'action-1',title:'Разместить сведения',deadline:null,executionStatus:'open',reviewRequired:false},
    ]}]};
    vi.mocked(db.complianceBaseline).mockResolvedValue(baseline as any);
    vi.mocked(db.updateActionStatus).mockResolvedValue({id:'action-1',execution_status:'completed'} as any);
    const max=client(),handle=createBotUpdateHandler({client:max,config});
    await handle(callback('action:done:action-1'));
    expect(db.updateActionStatus).toHaveBeenCalledWith(expect.objectContaining({companyId:'company-max-42',actionId:'action-1',status:'completed'}));
    expect(max.answerCallback).toHaveBeenCalledWith(expect.objectContaining({text:expect.stringContaining('отмечено выполненным')}));
  });
});
