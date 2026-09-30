import { describe, expect, it } from 'vitest';
import {
  actionButtons,
  actionsMessage,
  BOT_COMMANDS,
  detectIntent,
  documentsMessage,
  mainMenuButtons,
  requirementsMessage,
  searchRequirements,
  searchMessage,
  statusMessage,
} from './scenarios.js';

describe('chatbot intent routing', () => {
  it('routes slash commands and common Russian phrases', () => {
    expect(detectIntent('/start')).toBe('start');
    expect(detectIntent('/status')).toBe('status');
    expect(detectIntent('/requirements something')).toBe('requirements');
    expect(detectIntent('что мне нужно сделать')).toBe('actions');
    expect(detectIntent('что изменилось')).toBe('changes');
    expect(detectIntent('какие документы нужны')).toBe('documents');
    expect(detectIntent('покажи историю')).toBe('history');
    expect(detectIntent('мой бизнес')).toBe('profile');
    expect(detectIntent('как пользоваться')).toBe('help');
    expect(detectIntent('открыть мини-приложение')).toBe('app');
  });

  it('does not invent a legal answer for arbitrary free text', () => {
    expect(detectIntent('Можно ли мне продавать этот товар без лицензии?')).toBe('unknown');
  });

  it('keeps the visible command list unique and within MAX limits', () => {
    expect(BOT_COMMANDS.length).toBeGreaterThan(0);
    expect(BOT_COMMANDS.length).toBeLessThanOrEqual(32);
    expect(new Set(BOT_COMMANDS.map((item) => item.name)).size).toBe(BOT_COMMANDS.length);
  });
});

describe('chatbot UI copy', () => {
  const baseline = {
    summary: { actionRequired: 2, needsInfo: 1, verify: 3, selfReportedCompleted: 4 },
    coverage: { activeRulesAssessed: 37 },
    items: [
      {
        id: 'impact-1', ruleId: 'rule-1', complianceState: 'action_required', questions: [],
        rule: { userTitle: 'Проверить сведения на сайте' },
        actions: [{ id: 'action-1', title: 'Разместить сведения', deadline: '2026-10-10', executionStatus: 'open', reviewRequired: false }],
      },
      {
        id: 'impact-2', ruleId: 'rule-2', complianceState: 'unknown', verdict: 'needs_info',
        questions: [{ field: 'x' }], rule: { userTitle: 'Уточнить обработку данных' }, actions: [],
      },
    ],
  };

  it('renders a concise status without claiming full legal coverage', () => {
    const text = statusMessage(baseline);
    expect(text).toContain('требуют действий: 2');
    expect(text).toContain('оценено активных требований: 37');
    expect(text).toContain('не полная юридическая экспертиза');
  });

  it('prioritizes requirements that need clarification or action', () => {
    const text = requirementsMessage(baseline);
    expect(text).toContain('Уточнить обработку данных — нужно уточнить');
    expect(text).toContain('Проверить сведения на сайте — нужно действие');
  });

  it('offers in-chat completion and native mini-app navigation for actions', () => {
    expect(actionsMessage(baseline)).toContain('Разместить сведения');
    const buttons = actionButtons('t106_hakaton_max_bot', baseline);
    expect(buttons[0]?.[0]).toMatchObject({ type: 'callback', payload: 'action:ask:action-1' });
    expect(buttons[0]?.[1]).toMatchObject({ type: 'open_app', web_app: 't106_hakaton_max_bot', payload: 'assessment_impact-1' });
  });

  it('uses native open_app for the main menu', () => {
    expect(mainMenuButtons('t106_hakaton_max_bot')[0]?.[0]).toMatchObject({
      type: 'open_app', web_app: 't106_hakaton_max_bot', payload: 'home',
    });
  });

  it('summarizes the document checklist without exposing implementation fields', () => {
    const text=documentsMessage({summary:{total:4,present:1,missing:2,clarify:1},items:[
      {state:'missing',title:'Политика обработки персональных данных'},
      {state:'missing',title:'Сведения о продавце'},
    ]});
    expect(text).toContain('нужно сделать: 2');
    expect(text).toContain('Политика обработки персональных данных');
  });

  it('searches only the already-calculated personal requirements for free text', () => {
    const personal={...baseline,items:[
      ...baseline.items,
      {id:'impact-3',ruleId:'rule-3',complianceState:'unknown',questions:[],actions:[],rule:{userTitle:'Уведомление Роскомнадзора об обработке персональных данных',summary:'Персональные данные клиентов'}},
    ]};
    const matches=searchRequirements(personal,'что у меня по персональным данным?');
    expect(matches.map((item:any)=>item.id)).toContain('impact-3');
    expect(searchMessage(matches)).toContain('подтверждённой базе сервиса');
  });
});
