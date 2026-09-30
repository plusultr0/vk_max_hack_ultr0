"""Static responsive smoke test for the administrator review UI using production CSS."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import argparse,json
ROOT=Path(__file__).resolve().parents[2]
BODY='''<div class="rv-root"><header class="rv-top"><a class="rv-brand">RC <span>Регуляторный контроль</span></a><span class="rv-workspace">Проверка источников</span><div><span class="rv-help">Общий администратор</span><button>Выйти</button></div></header><div class="rv-layout"><aside class="rv-queue"><div class="rv-queue-head"><h1>На проверке</h1><button aria-label="Обновить список">↻</button></div><label class="rv-field"><span>Статус кандидатов</span><select><option>Ожидают проверки</option></select></label><label class="rv-field"><span>Поиск по названию</span><input value="цифровой рубль"></label><div class="rv-candidate-list"><button class="selected"><span>gigachat</span><strong>Проверка нового требования для бизнеса с длинным названием документа</strong><small>27.09.2026</small></button><button><span>gigachat</span><strong>Второй документ</strong><small>27.09.2026</small></button></div></aside><aside class="rv-source"><div class="rv-source-head"><span class="rv-eyebrow">ИСХОДНЫЙ ДОКУМЕНТ</span><h2>Официальный источник требования</h2><a>Открыть источник ↗</a></div><div class="rv-source-scroll"><article class="highlight"><span class="rv-segment-number">§ 1</span><p>Фрагмент официального текста для визуальной проверки длинных строк и выделения выбранной цитаты.</p></article><article><span class="rv-segment-number">§ 2</span><p>Следующий фрагмент источника.</p></article></div></aside><main class="rv-editor"><div class="rv-review-head"><span class="rv-eyebrow">РАБОЧАЯ РЕВИЗИЯ · 2</span><h1>Проверка приёма оплаты цифровыми рублями</h1><div class="rv-badges"><span>Черновик</span><span class="rv-unsaved">Есть несохранённые правки</span></div></div><section class="rv-section"><h2>Основные данные</h2><div class="rv-form-grid"><label class="rv-field"><span>Название</span><input value="Проверка требования"></label><label class="rv-field"><span>Категория</span><select><option>Платежи</option></select></label></div><label class="rv-field"><span>Пояснение для пользователя</span><textarea>Понятный текст без технических обозначений.</textarea></label></section><section class="rv-section"><h2>Условия и источники</h2><div class="rv-item"><div class="rv-item-head"><b>Условие 1</b><span>обязательное</span></div><div class="rv-expression">Выручка бизнеса больше указанного порога</div><div class="rv-citations"><a>§ 1</a><a>§ 2</a></div></div></section><div class="rv-save"><div><button>Сохранить черновик</button><button class="rv-primary">Готово к следующему этапу</button></div><small>Изменения ещё не опубликованы.</small></div></main></div></div>'''
def frame():
    css=(ROOT/'apps/web/src/styles.css').read_text()+'\n'+(ROOT/'apps/web/src/review/review.css').read_text()
    return '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style><body>'+BODY+'</body></html>'
if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('--chromium');ap.add_argument('--output',type=Path,default=ROOT/'test-results/review-layout');args=ap.parse_args();args.output.mkdir(parents=True,exist_ok=True)
    cases=[]
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=args.chromium) if args.chromium else p.chromium.launch()
        for width in [320,375,768,1024,1440]:
            page=browser.new_page(viewport={'width':width,'height':900});page.set_content(frame());page.wait_for_timeout(50)
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),(width,'horizontal overflow')
            for button in page.locator('button:visible').all():
                box=button.bounding_box();assert box and box['height']>=41,(width,'small target')
                if width<=760:assert box['height']>=43,(width,'small mobile target')
            if width in [320,375,1440]:page.screenshot(path=str(args.output/f'review-{width}.png'),full_page=True)
            cases.append({'screen':'review','width':width,'status':'passed'});page.close()
        browser.close()
    report={'scope':'Static review UI layout only; no React or backend execution','cases':cases}
    (args.output/'review-layout-report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
