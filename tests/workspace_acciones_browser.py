"""Regresiones de las acciones de la cabecera del Workspace sobre pnpm dev.

python tests/workspace_acciones_browser.py [--app URL] [--channel msedge] [--engine webkit]
"""

import argparse
import re
import sys

from playwright.sync_api import expect, sync_playwright


def start(browser, url):
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(url)
    page.locator("button.primary[type=submit]").click()
    page.get_by_role("button", name="Retomar diseño en calaix").or_(page.locator("button.rs-item")).filter(visible=True).first.click()
    expect(page.locator(".center-head .ch-name")).to_be_visible()
    return page, errors


def panel_button(page, name):
    return page.get_by_role("group", name="Paneles del proyecto").filter(visible=True).get_by_role("button", name=name)


def layout_button(page, name):
    return page.get_by_role("group", name="Disposición").get_by_role("button", name=name, exact=True)


def unreachable(page):
    """Botones visibles de las cabeceras que quedan recortados o tapados."""
    return page.evaluate("""() => [...document.querySelectorAll('.center-head button, .panel-head button')]
        .filter((button) => {
            const box = button.getBoundingClientRect();
            if (!box.width || getComputedStyle(button).visibility === 'hidden') return false;
            return [box.left + 3, box.right - 3].some((x) => !button.contains(document.elementFromPoint(x, box.top + box.height / 2)));
        })
        .map((button) => button.getAttribute('aria-label') || button.title || button.textContent.trim())""")


def check_panels(browser, url):
    page, errors = start(browser, url)
    panel = page.locator("#workspace-right-panel")
    for name in ("Cambios", "Archivos"):
        button = panel_button(page, name)
        button.click()
        expect(button).to_have_attribute("aria-pressed", "true")
        expect(panel).to_be_in_viewport(ratio=0.99)
        expect(button).not_to_be_focused()
        button.click()
        expect(button).to_have_attribute("aria-pressed", "false")
        expect(panel).to_be_hidden()
    assert not errors, errors
    page.close()


def check_disposition(browser, url):
    page, errors = start(browser, url)
    panel = page.locator("#workspace-right-panel")
    for name in ("Dividida", "Código"):
        layout_button(page, name).click()
        expect(panel).to_be_in_viewport(ratio=0.99)
        files = panel_button(page, "Archivos")
        expect(files).to_have_attribute("aria-pressed", "true")
        files.click()
        # Sin panel solo queda la conversación: es lo que debe marcar el selector.
        expect(layout_button(page, "Conversación")).to_have_attribute("aria-pressed", "true")
        expect(layout_button(page, name)).to_have_attribute("aria-pressed", "false")
    assert not errors, errors
    page.close()


def check_keyboard(browser, url):
    page, errors = start(browser, url)
    layout_button(page, "Código").press("Enter")
    back = page.get_by_role("button", name="Conversación").filter(has_text="Conversación")
    expect(back).to_be_focused()
    back.press("Enter")
    expect(layout_button(page, "Conversación")).to_be_focused()
    layout_button(page, "Código").press("Enter")
    panel_button(page, "Archivos").press("Enter")
    expect(layout_button(page, "Conversación")).to_be_focused()
    assert not errors, errors
    page.close()


def check_widths(browser, url):
    page, errors = start(browser, url)
    layout_button(page, "Código").click()
    page.locator("#workspace-right-panel").get_by_text("README.md").first.click()
    expect(page.get_by_role("button", name="Cerrar README.md")).to_be_visible()
    for width in (1440, 960):
        page.set_viewport_size({"width": width, "height": 700})
        for shortcut in ("Control+Alt+3", "Control+Alt+2", "Control+Alt+1"):
            page.keyboard.press(shortcut)
            page.evaluate("() => { document.querySelector('.center-head .ch-name').textContent = 'Un título de sesión muy largo '.repeat(4); }")
            page.wait_for_timeout(400)
            assert not unreachable(page), (width, shortcut, unreachable(page))
        panel_button(page, re.compile("^Archivos$")).click()
        expect(page.locator("#workspace-right-panel")).to_be_in_viewport(ratio=0.99)
        assert not unreachable(page), (width, "Archivos", unreachable(page))
    assert not errors, errors
    page.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", default="http://127.0.0.1:1420")
    parser.add_argument("--channel", default=None)
    parser.add_argument("--engine", choices=("chromium", "webkit"), default="chromium")
    args = parser.parse_args()
    # La consola de Windows no siempre admite los símbolos de los mensajes de Playwright.
    sys.stdout.reconfigure(errors="replace")
    failed = []
    with sync_playwright() as playwright:
        browser = getattr(playwright, args.engine).launch(channel=args.channel)
        for check in (check_panels, check_disposition, check_keyboard, check_widths):
            try:
                check(browser, args.app)
                print(f"{check.__name__}: correcto")
            except AssertionError as error:
                failed.append(check.__name__)
                print(f"{check.__name__}: FALLA\n{str(error)[:600]}")
        browser.close()
    if failed:
        raise SystemExit(f"Fallan: {', '.join(failed)}")


if __name__ == "__main__":
    main()
