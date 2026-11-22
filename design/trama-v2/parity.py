import sys
from playwright.sync_api import sync_playwright
from PIL import Image, ImageDraw
OUT='/home/claude/repo/docs/trama-paridad'
SECTIONS=[('inicio','home','Meta+Shift+1',None),('workspace','workspace','Meta+Shift+2',None),('flow','flow','Meta+Shift+3',None),('flow-demo','flow','Meta+Shift+3','demo'),('studio','studio','Meta+Shift+4',None),('entrega','review','Meta+Shift+5',None),('brain','brain','Meta+Shift+6',None),('ajustes','ajustes','Meta+Comma',None)]
for w,h in [(1600,900),(1280,800)]:
    with sync_playwright() as p:
        b=p.chromium.launch(args=['--enable-unsafe-swiftshader'])
        ref=b.new_page(viewport={'width':w,'height':h}); ref.goto('file:///home/claude/v2/index.html'); ref.wait_for_timeout(900)
        app=b.new_page(viewport={'width':w,'height':h}); errs=[]
        app.on('pageerror',lambda e: errs.append(str(e)))
        app.goto('http://localhost:5173/'); app.wait_for_timeout(1500)
        if app.locator('button.primary[type=submit]').count(): app.locator('button.primary[type=submit]').click(); app.wait_for_timeout(900)
        for name,rv,key,extra in SECTIONS:
            proj='kaza' if extra=='demo' else ('calaix' if name in ('workspace','studio') else 'bitacola')
            app.keyboard.press('Meta+Shift+1'); app.wait_for_timeout(500)
            app.locator(f".prow[aria-label='Abrir {proj}']").first.click(); app.wait_for_timeout(600)
            app.keyboard.press(key); app.wait_for_timeout(1800)
            if extra=='demo': app.locator('.flow-demo').click(); app.wait_for_timeout(1500)
            ref.evaluate(f"go('{rv}')"); ref.wait_for_timeout(1400)
            ra=f'/tmp/r-{name}.png'; aa=f'/tmp/a-{name}.png'
            ref.screenshot(path=ra); app.screenshot(path=aa)
            A=Image.open(ra).convert('RGB'); B=Image.open(aa).convert('RGB')
            S=Image.new('RGB',(w*2+20,h+40),(4,5,6)); S.paste(A,(0,40)); S.paste(B,(w+20,40))
            d=ImageDraw.Draw(S); d.text((12,12),f'Artifact Trama v2 · {w}x{h}',fill=(200,205,215)); d.text((w+32,12),f'Filigranas (núcleo simulado) · {name}',fill=(200,205,215))
            S.save(f'{OUT}/{name}-{w}.png'); B.save(f'{OUT}/app-{name}-{w}.png')
        print(w,'errores',errs[:3])
        b.close()
