"""CSS-only fixtures using production styles. Not React E2E or API testing."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import argparse,json
ROOT=Path(__file__).resolve().parents[2]
NAV=''.join('<button class="'+a+'"><span>'+t+'</span></button>' for a,t in [('active','\u0422\u0440\u0435\u0431\u043e\u0432\u0430\u043d\u0438\u044f'),('','\u0418\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u044f'),('','\u041c\u043e\u0439 \u0431\u0438\u0437\u043d\u0435\u0441')])
def frame(content,detail=False):
    bottom='' if detail else '<nav class="bottom-nav">'+NAV+'</nav>'
    layout_class='layout layout-detail' if detail else 'layout'
    return '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+ (ROOT/'apps/web/src/styles.css').read_text() +'</style><body><div class="app-shell"><header class="topbar"><a class="brand"><span class="brand-mark">&#10003;</span><span>Check \u041f\u0440\u0430\u0432\u043e</span></a></header><div class="'+layout_class+'"><aside class="sidebar"><nav>'+NAV+'</nav></aside><main class="content">'+content+'</main></div>'+bottom+'</div></body></html>'
if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('--chromium');ap.add_argument('--output',type=Path,default=ROOT/'test-results/layout');args=ap.parse_args();args.output.mkdir(parents=True,exist_ok=True)
    cases=[]
    fixtures=json.loads((ROOT/'tests/layout/fixtures.json').read_text())
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=args.chromium) if args.chromium else p.chromium.launch()
        for width in [320,375,768,1024,1440]:
            for name,body in fixtures.items():
                page=browser.new_page(viewport={'width':width,'height':900})
                detail=name.startswith('detail_') or name=='stress_long_text'
                page.set_content(frame(body,detail));page.wait_for_timeout(50)
                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),(name,width,'horizontal overflow')
                nav=page.locator('nav:visible')
                expected_nav=0 if detail and width<=640 else 1
                assert nav.count()==expected_nav,(name,width,'navigation count')
                if expected_nav:
                    buttons=nav.locator('button');assert buttons.count()==3
                    boxes=[b.bounding_box() for b in buttons.all()]
                    assert all(b and b['height']>=44 for b in boxes)
                    if page.locator('.bottom-nav').is_visible():assert len({round(b['y']) for b in boxes})==1
                for b in page.locator('button:visible').all():
                    box=b.bounding_box();assert box['height']>=43,(name,width,'small target')
                # Core alignment invariants: repeated cards/rows must share the same edges and spacing.
                cards=page.locator('.card-list > :visible')
                if cards.count()>1:
                    boxes=[c.bounding_box() for c in cards.all()]
                    assert all(boxes)
                    lefts=[round(b['x'],1) for b in boxes]; rights=[round(b['x']+b['width'],1) for b in boxes]
                    assert max(lefts)-min(lefts)<=1.5,(name,width,'card left edges')
                    assert max(rights)-min(rights)<=1.5,(name,width,'card right edges')
                    gaps=[boxes[i+1]['y']-(boxes[i]['y']+boxes[i]['height']) for i in range(len(boxes)-1)]
                    assert all(14<=g<=18 for g in gaps),(name,width,'card vertical gap',gaps)
                fields=page.locator('.profile-grid > fieldset:visible')
                if fields.count()>1:
                    boxes=[f.bounding_box() for f in fields.all()]
                    assert all(boxes)
                    assert max(b['x'] for b in boxes)-min(b['x'] for b in boxes)<=1.5,(name,width,'profile left edges')
                    assert max(b['width'] for b in boxes)-min(b['width'] for b in boxes)<=1.5,(name,width,'profile widths')
                summaries=page.locator('.check-summary > div:visible')
                if summaries.count()>1:
                    boxes=[x.bounding_box() for x in summaries.all()]
                    # Responsive grid can have multiple rows. Compare only peers
                    # in the same row, not different rows with different wrapping.
                    for y in {round(b['y']) for b in boxes}:
                        row=[b for b in boxes if abs(b['y']-y)<1]
                        assert max(b['height'] for b in row)-min(b['height'] for b in row)<=1.5,(name,width,'summary row equal heights')
                if width in [320,375,1440]:page.screenshot(path=str(args.output/f'{name}-{width}.png'),full_page=True)
                cases.append({'screen':name,'width':width,'status':'passed'});page.close()
        browser.close()
    report={'scope':'CSS fixture only; no React or backend execution','cases':cases}
    (args.output/'layout-report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
