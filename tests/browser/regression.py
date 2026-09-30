"""0.9.20 real React/Vite UI contract regression with intercepted HTTP.
No fake HTML, production keys, PostgreSQL, MAX or GigaChat calls.
Requirements and server responses here are synthetic test fixtures.
"""
import argparse, copy, json, re
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

QUESTION = "Какова выручка за проверяемый год?"
TITLE = "Учебное требование с вопросом"
OTHER = "Учебное требование с действием"
FRESH = "Новое учебное требование"
ACTION = "Выполнить учебное действие"
DOC = "Документ из учебного примера"
FIELDS = ["legalForm", "industry", "taxRegime", "sellsToConsumers", "distanceSales", "collectsPersonalData"]
DATA = dict(legalForm="LLC", industry="retail_non_food", region="77", taxRegime="USN", sellsToConsumers=True,
            salesChannels=["own_site"], distanceSales=True, onlinePayment=True, collectsPersonalData=True)
Q = dict(field="facts.test.revenue", text=QUESTION, hint="Синтетический пример для проверки интерфейса.",
         inputType="number", min=0, max=None, unit="RUB", definitionVersion=1, status="missing", expectedObservationId=None)

def card(id="old", title=TITLE):
    item = dict(id=id, isCurrent=True, timeState="active", profileVersion=1,
                ruleId={"old":"test_dynamic_rule","other":"test_action_rule","fresh":"test_fresh_rule"}.get(id,"test_dynamic_rule"),
                ruleVersion=1, verdict="needs_info", reviewState="auto", complianceState="unknown",
                clarificationState="needs_info", effectiveFrom="2026-01-01", reviewReasons=[],
                reasons=["facts.test.revenue gt 100 = false", "STALE_IMPACT"],
                questions=[copy.deepcopy(Q)] if title == TITLE else [], editableQuestions=[], actions=[],
                explanation={"facts":[], "requirement":"Синтетическое условие, не юридическая рекомендация."},
                rule=dict(userTitle=title, summary="Учебное правило для проверки интерфейса.", category="test",
                          legalStatus="active", checkedAt="2026-09-25", approvalMode="human", evidenceRefs=[
                              dict(id="official", url="https://cbr.ru/", label="Источник учебного примера"),
                              dict(id="reference", url="https://www.consultant.ru/", label="Справочная публикация примера")]))
    if title != TITLE:
        item.update(verdict="applies", complianceState="action_required", clarificationState=None,
                    actions=[dict(id=id+"-action", actionKey="demo_action", title=ACTION, description="Учебный шаг.",
                                  deadline=None, executionStatus="open", reviewRequired=False)])
    return item

class State:
    def __init__(self, new=False):
        self.profile = dict(confirmed=None if new else dict(DATA, profileVersion=1, confirmedAt="2026-09-25"),
            draft=dict(data={} if new else copy.deepcopy(DATA), answeredFields=[] if new else list(DATA),
                       baseProfileVersion=0 if new else 1),
            progress=dict(answered=0 if new else 6, total=6, percent=0 if new else 100,
                          canConfirm=not new, missing=FIELDS.copy() if new else []))
        self.cards = [] if new else [card(),card("other",OTHER)]
        self.fail_once=False; self.fail_confirm_once=False; self.calls=[]; self.mark="unchecked"
        self.refresh_failures=0; self.feed_extra=None; self.history_calls=[]; self.audit_calls=[]
    def impacts(self):
        return dict(profileVersion=self.profile["draft"]["baseProfileVersion"],
                    impacts=copy.deepcopy(self.cards),refreshPending=False,refreshFailures=self.refresh_failures)
    def set_action(self,status):
        self.cards[1]["actions"][0]["executionStatus"]=status
    def checks(self):
        base=dict(version=1,impactId="other",ruleId="test_action_rule",ruleVersion=1,
                  sources=[],basisHash="a"*64,needsRecheck=False,canAnswer=True,clarification="",answeredAt=None)
        action_state="present" if self.cards[1]["actions"][0]["executionStatus"]=="completed" else "missing"
        items=[dict(base,checkKey="demo-document",kind="document",title=DOC,help="Учебный документ.",state=self.mark),
               dict(base,checkKey="demo-action",kind="action",title=ACTION,help="Учебное действие.",
                    actionId="other-action",executionStatus=self.cards[1]["actions"][0]["executionStatus"],state=action_state)]
        summary=dict(total=len(items),present=0,missing=0,clarify=0,unknown=0,unchecked=0,upcoming=0)
        for item in items: summary[item["state"]]+=1
        return dict(items=items,summary=summary,coverage=dict(warning="Учебный каталог. Содержимое не проверяется."))
    def handle(self,route):
        req=route.request; parsed=urlparse(req.url); path=parsed.path; method=req.method; query=parse_qs(parsed.query)
        def send(obj,status=200):
            route.fulfill(status=status,content_type="application/json",body=json.dumps(obj,ensure_ascii=False))
        if method=="OPTIONS":
            route.fulfill(status=204,headers={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"*","Access-Control-Allow-Methods":"*"});return
        if path=="/auth/dev":send(dict(token="synthetic-browser-session",companyId="browser-test",dev=True));return
        if path=="/auth/me":send(dict(companyId="browser-test",dev=True));return
        if path=="/company/profile":
            if method=="PUT":
                b=req.post_data_json
                assert b["baseProfileVersion"]==self.profile["draft"]["baseProfileVersion"]
                self.profile["draft"]["data"].update(b["patch"])
                self.profile["draft"]["answeredFields"]=b["answeredFields"]
                n=sum(field in b["answeredFields"] for field in FIELDS)
                self.profile["progress"]=dict(answered=n,total=6,percent=100*n/6,canConfirm=n==6,
                                              missing=[f for f in FIELDS if f not in b["answeredFields"]])
            send(self.profile);return
        if path=="/company/profile/confirm":
            if self.fail_confirm_once:
                self.fail_confirm_once=False;send(dict(error="PROFILE_CONFIRM_FAILED"),500);return
            assert self.profile["progress"]["canConfirm"]
            self.profile["draft"]["baseProfileVersion"]+=1
            self.profile["confirmed"]=dict(self.profile["draft"]["data"],
                profileVersion=self.profile["draft"]["baseProfileVersion"],confirmedAt="2026-09-29")
            self.cards=[card(),card("other",OTHER)]
            send(dict(profile=self.profile["confirmed"],impacts=self.impacts()));return
        if path=="/company/profile/history":
            cursor=query.get("beforeVersion",[""])[0];self.history_calls.append(cursor)
            item=dict(id="profile-"+("2" if cursor else "3"),profile_version=2 if cursor else 3,confirmed_at="2026-09-29",
                      changes=[dict(field="region",before="77",after="78",hadBefore=True,hasAfter=True)])
            send(dict(items=[item],nextVersion=None if cursor else 3));return
        if path=="/impacts":send(self.impacts());return
        if re.match(r"/impacts/[^/]+/answers$",path):
            b=req.post_data_json;self.calls.append(b)
            if self.fail_once:
                self.fail_once=False;send(dict(error="FACT_ANSWER_FAILED",message="SQL password must not appear"),500);return
            assert isinstance(b["answers"][0]["value"],(int,float))
            next_card=card("answer-"+str(len(self.calls)))
            next_card.update(verdict="not_applicable",questions=[],clarificationState=None,
                editableQuestions=[dict(Q,status="fresh",currentValue=b["answers"][0]["value"],expectedObservationId="observation-new")])
            self.cards[0]=next_card;send(dict(impacts=self.impacts()));return
        if path.startswith("/actions/") and method=="PATCH":
            assert path=="/actions/other-action"
            self.set_action(req.post_data_json["status"]);send(dict(ok=True));return
        if path=="/regulatory/feed":
            cards=[i for i in self.cards if i["verdict"]!="not_applicable"]
            if self.feed_extra:cards.append(self.feed_extra)
            send(dict(items=[dict(impact=i,publishedAt=None,discoveredAt=None,addedAt="2026-09-29",
                                  effectiveFrom=i["effectiveFrom"],isRecent=True) for i in cards],
                      total=len(cards),nextOffset=None));return
        if path=="/company/compliance/refresh":
            self.refresh_failures=0;send(dict(ok=True));return
        if path=="/company/checks":send(self.checks());return
        if path=="/company/checks/answer":
            b=req.post_data_json
            if b["checkKey"]=="demo-action":
                assert b["answer"] in ["present","missing"]
                self.set_action("completed" if b["answer"]=="present" else "open")
            else:self.mark=b["answer"]
            send(dict(id="fixture-mark",answer=b["answer"]));return
        if path=="/audit":
            cursor=query.get("beforeId",[""])[0];self.audit_calls.append(cursor)
            send(dict(items=[dict(id="99" if cursor else "100",event_type="profile.confirmed",created_at="2026-09-29")],
                      nextCursor=None if cursor else "100"));return
        if path=="/impacts/history":send(dict(profileVersion=1,impacts=[]));return
        if path.startswith("/impacts/"):
            found=next((i for i in self.cards+([self.feed_extra] if self.feed_extra else []) if i["id"]==path.rsplit("/",1)[-1]),None)
            send(found or dict(error="IMPACT_NOT_FOUND"),200 if found else 404);return
        if parsed.hostname not in {"127.0.0.1","localhost"}:route.abort();return
        route.continue_()

def no_overflow(page):
    assert page.evaluate("document.documentElement.scrollWidth<=innerWidth+1"),"horizontal overflow"
def visible_nav(page):
    nav=page.locator("nav:visible");assert nav.count()==1
    assert nav.get_by_role("button").count()==3
    return nav
def touch_targets(page):
    for button in page.locator("button:visible").all():
        box=button.bounding_box()
        assert box and box["height"]>=43, "small button target"
def home(page):
    page.locator(".brand").click()
    expect(page.get_by_role("heading",name="Что проверить в вашем бизнесе",exact=True)).to_be_visible()
def documents(page):
    home(page)
    page.get_by_role("button",name=re.compile("Документы и важные настройки")).click()
    expect(page.locator(".check-card")).to_have_count(2)
def open_card(page,title):
    page.locator(".summary-card").filter(has=page.get_by_role("heading",name=title,exact=True)).click()
    expect(page.get_by_test_id("impact-detail")).to_be_visible()
def wake(page):
    page.evaluate("window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange'));")
def run(base,chromium,out):
    out.mkdir(parents=True,exist_ok=True)
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=chromium) if chromium else p.chromium.launch()
        completed=[]
        try:
            for width in [320,375,768,1440]:
                ctx=browser.new_context(viewport=dict(width=width,height=900))
                page=ctx.new_page();state=State();errors=[]
                page.on("pageerror",lambda error:errors.append(str(error)))
                page.route("**/*",state.handle);page.goto(base,wait_until="networkidle")
                expect(page.get_by_role("heading",name="Что проверить в вашем бизнесе")).to_be_visible()
                visible_nav(page);no_overflow(page)
                expect(page.locator(".scope-note")).to_contain_text("не охватывает всё законодательство")
                open_card(page,TITLE)
                detail=page.get_by_test_id("impact-detail")
                expect(page.get_by_label(QUESTION,exact=True)).to_be_enabled()
                page.get_by_label(QUESTION,exact=True).fill("12500,50")
                expect(page.get_by_label(QUESTION,exact=True)).to_have_value("12 500,50")
                # A resume must not destroy an unsaved answer to an unchanged question.
                wake(page);page.wait_for_timeout(400)
                expect(page.get_by_label(QUESTION,exact=True)).to_have_value("12 500,50")
                state.fail_once=True
                submit=page.get_by_role("button",name="Сохранить и обновить результат",exact=True)
                submit.click()
                expect(detail.locator("[role=alert]")).to_be_visible()
                expect(page.get_by_label(QUESTION,exact=True)).to_have_value("12 500,50")
                submit.click()
                expect(page.get_by_text("Исправить ответы",exact=True)).to_be_visible()
                assert len(state.calls)==2 and state.calls[0]["requestId"]==state.calls[1]["requestId"]
                assert state.calls[-1]["answers"][0]["value"]==12500.50
                assert "SQL password" not in detail.inner_text()
                assert "STALE_IMPACT" not in detail.inner_text()
                assert "Ваши ответы, которые повлияли" not in detail.inner_text()
                page.get_by_text("Исправить ответы",exact=True).click()
                page.get_by_label(QUESTION,exact=True).fill("200")
                page.get_by_role("button",name="Сохранить и обновить результат",exact=True).click()
                expect(detail).to_be_visible()
                expect(page.get_by_text("Исправить ответы",exact=True)).to_be_visible()
                assert state.calls[-1]["edit"] is True
                page.get_by_text("Источники и даты",exact=True).click()
                expect(page.locator(".source-link-kicker").filter(has_text="Официальный источник")).to_have_count(1)
                expect(page.locator(".source-link-kicker").filter(has_text="Справочная публикация")).to_have_count(1)
                no_overflow(page)
                page.screenshot(path=str(out/f"detail-{width}.png"),full_page=True)
                page.get_by_role("button",name="← К требованиям",exact=True).click()
                expect(page.get_by_role("heading",name=OTHER,exact=True)).to_be_visible()
                open_card(page,OTHER)
                page.get_by_role("button",name="Отметить выполненным",exact=True).click()
                expect(page.get_by_role("button",name="✓ Выполнено",exact=True)).to_be_enabled()
                documents(page)
                action_check=page.locator(".check-card").filter(has=page.get_by_role("heading",name=ACTION,exact=True))
                expect(action_check.locator(".status")).to_contain_text("Отмечено готовым")
                action_check.locator(".check-heading").click()
                expect(action_check.get_by_role("button",name="Не знаю",exact=True)).to_have_count(0)
                action_check.get_by_role("button",name="Нужно выполнить",exact=True).click()
                expect(action_check.locator(".status")).to_contain_text("Нужно выполнить")
                home(page);open_card(page,OTHER)
                expect(page.get_by_role("button",name="Отметить выполненным",exact=True)).to_be_enabled()
                # Simulate a server update made via the bot, without reloading.
                state.set_action("completed");wake(page)
                expect(page.get_by_role("button",name="✓ Выполнено",exact=True)).to_be_visible()
                documents(page)
                doc=page.locator(".check-card").filter(has=page.get_by_role("heading",name=DOC,exact=True))
                doc.locator(".check-heading").click()
                doc.get_by_role("button",name="Проверил, всё готово",exact=True).click()
                expect(doc.locator(".status")).to_contain_text("Отмечено готовым")
                page.reload(wait_until="networkidle");documents(page)
                expect(page.locator(".check-card").filter(has_text=DOC).locator(".status")).to_contain_text("Отмечено готовым")
                assert len(page.locator(".check-summary > div").all())==5
                no_overflow(page);touch_targets(page)

                # Fresh feed response intentionally not in the impacts list.
                state.feed_extra=card("fresh",FRESH)
                visible_nav(page).get_by_role("button",name="Изменения",exact=True).click()
                open_card(page,FRESH)
                expect(page.get_by_role("button",name="Отметить выполненным",exact=True)).to_be_enabled()
                expect(page.get_by_text("Это предыдущая версия результата.",exact=False)).to_have_count(0)
                expect(page.get_by_role("button",name="← К изменениям",exact=True)).to_be_visible()
                home(page)
                state.refresh_failures=1;wake(page)
                expect(page.get_by_text("Не удалось пересчитать часть требований.",exact=True)).to_be_visible()
                page.get_by_role("button",name="Повторить пересчёт",exact=True).click()
                expect(page.get_by_text("Не удалось пересчитать часть требований.",exact=True)).to_have_count(0)
                assert not errors,errors
                completed.append(f"{width}px: number/retry/edit; shared actions; resume; fresh feed; sources; failure retry; persisted document; layout")
                ctx.close()

            # Onboarding needs six answers including industry; optional data is not fabricated.
            ctx=browser.new_context(viewport=dict(width=375,height=900))
            page=ctx.new_page();new=State(new=True);page.route("**/*",new.handle);page.goto(base,wait_until="networkidle")
            expect(page.get_by_role("heading",name="Расскажите о своём бизнесе")).to_be_visible()
            expect(page.locator(".profile-form fieldset:visible")).to_have_count(6)
            page.locator("#profile-legalForm").click(); page.get_by_role("option",name="ИП",exact=True).click()
            page.locator("#profile-industry").click(); page.get_by_role("option",name="IT, разработка и онлайн-сервисы",exact=True).click()
            page.locator("#profile-taxRegime").click(); page.get_by_role("option",name="УСН",exact=False).click()
            for field in page.locator(".profile-form fieldset:visible").all():
                unknown=field.get_by_role("button",name="Не знаю",exact=True)
                if unknown.count():unknown.click()
            page.get_by_role("button",name="Сохранить и показать требования",exact=True).click()
            expect(page.get_by_role("heading",name="Что проверить в вашем бизнесе")).to_be_visible()
            assert new.profile["confirmed"]["sellsToConsumers"] is None
            assert all(field not in new.profile["confirmed"] for field in ["region","salesChannels","onlinePayment"])
            completed.append("onboarding: six required answers including industry; unknown preserved; optional data untouched")
            ctx.close()

            ctx=browser.new_context(viewport=dict(width=375,height=900))
            page=ctx.new_page();state=State();page.route("**/*",state.handle);page.goto(base,wait_until="networkidle")
            page.get_by_test_id("requirements-filter").click();page.get_by_role("option",name="Не относятся к вам",exact=True).click()
            visible_nav(page).get_by_role("button",name="Мой бизнес",exact=True).click()
            page.get_by_text("Дополнительные сведения · необязательно",exact=True).click()
            page.locator("#profile-region").fill("Тестовый регион")
            page.get_by_role("button",name="Заказы пока не принимаем",exact=True).click()
            expect(page.locator(".profile-form .review-note")).to_be_visible()
            wake(page);page.wait_for_timeout(400)
            expect(page.locator("#profile-region")).to_have_value("Тестовый регион")
            # Confirm fails after PUT succeeds; retry must stay enabled.
            state.fail_confirm_once=True
            save=page.get_by_role("button",name="Сохранить и обновить требования",exact=True)
            save.click();expect(page.locator(".error-note[role=alert]")).to_be_visible()
            expect(save).to_be_enabled();save.click()
            expect(page.get_by_role("heading",name="Что проверить в вашем бизнесе")).to_be_visible()
            expect(page.get_by_test_id("requirements-filter")).to_contain_text("Требуют внимания")
            visible_nav(page).get_by_role("button",name="Мой бизнес",exact=True).click()
            page.get_by_role("button",name="Посмотреть историю изменений",exact=True).click()
            page.get_by_text("Версия 3",exact=False).click()
            expect(page.locator(".profile-diff")).to_contain_text("Было:")
            expect(page.locator(".profile-diff")).to_contain_text("Стало:")
            page.get_by_role("button",name="Показать более ранние ответы",exact=True).click()
            expect(page.locator(".profile-history details")).to_have_count(2)
            page.get_by_text("Изменения и действия",exact=True).click()
            page.get_by_role("button",name="Показать ещё события",exact=True).click()
            expect(page.locator(".history-events > p")).to_have_count(2)
            assert state.history_calls==["","3"] and state.audit_calls==["","100"]
            no_overflow(page);page.screenshot(path=str(out/"history-375.png"),full_page=True)
            completed.append("optional warnings; unsaved draft retained; failed confirm retry; attention reset; before/after history; keyset pages")
            ctx.close()
            result=dict(status="passed",scope="real React with intercepted synthetic API; not PostgreSQL/live MAX",checks=completed)
            (out/"browser-report.json").write_text(json.dumps(result,ensure_ascii=False,indent=2))
            print(json.dumps(result,ensure_ascii=False,indent=2))
        finally:browser.close()

if __name__=="__main__":
    ap=argparse.ArgumentParser();ap.add_argument("--base-url",default="http://127.0.0.1:5173")
    ap.add_argument("--chromium");ap.add_argument("--output",type=Path,default=Path("test-results/browser"))
    args=ap.parse_args();run(args.base_url,args.chromium,args.output)
