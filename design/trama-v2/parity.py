"""Captura Trama en Chromium y, si se suministra el export v2, monta las comparativas."""

import argparse
import json
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
SIZES = [(1600, 900), (1440, 900), (1280, 800), (1050, 720), (820, 600)]
SECTIONS = [
    ("inicio", "home", ".home", None),
    ("workspace", "workspace", ".threads", "calaix"),
    ("flow", "flow", ".flow", "bitacola"),
    ("flow-demo", "flow", ".flow", "kaza"),
    ("studio", "studio", ".studio", "calaix"),
    ("entrega", "review", ".rev", "bitacola"),
    ("brain", "brain", ".brain", "bitacola"),
    ("ajustes", "ajustes", ".set", "bitacola"),
]


def save_comparison(reference, app, destination, reference_label, label):
    with Image.open(reference) as ref_file, Image.open(app) as app_file:
        ref, actual = ref_file.convert("RGB"), app_file.convert("RGB")
        width, height = actual.size
        if ref.size != actual.size:
            raise ValueError(f"Dimensiones distintas: {ref.size} y {actual.size}")
        sheet = Image.new("RGB", (width * 2 + 20, height + 40), (4, 5, 6))
        sheet.paste(ref, (0, 40))
        sheet.paste(actual, (width + 20, 40))
        draw = ImageDraw.Draw(sheet)
        draw.text((12, 12), reference_label, fill="white")
        draw.text((width + 32, 12), label, fill="white")
        sheet.save(destination)
        return ImageChops.difference(ref, actual)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", default="http://127.0.0.1:1420")
    parser.add_argument("--artifact", help="Ruta al HTML exportado del Artifact")
    parser.add_argument("--reference-label", default="Artifact de referencia")
    parser.add_argument("--output", type=Path, default=ROOT / "docs/trama-paridad/actual")
    parser.add_argument("--channel", default=None, help="Canal Chromium, por ejemplo chrome")
    parser.add_argument("--diff", action="store_true", help="Guardar diferencias de píxel para datos y estados previamente alineados")
    args = parser.parse_args()

    if args.diff and not args.artifact:
        parser.error("--diff requiere --artifact")
    artifact = Path(args.artifact).expanduser().resolve(strict=True) if args.artifact else None
    args.output.mkdir(parents=True, exist_ok=True)
    results = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel=args.channel)
        if artifact:
            check = browser.new_page()
            check.goto(artifact.as_uri())
            if not check.evaluate("typeof go === 'function'"):
                parser.error("el export no expone la navegación de Trama")
            check.evaluate("go('ajustes')")
            if not check.locator(".set").count():
                parser.error("el export no contiene la pantalla Ajustes de Trama")
            check.close()

        for width, height in SIZES:
            for name, view, selector, project in SECTIONS:
                frame = {"width": width, "height": height}
                context = browser.new_context(viewport=frame, reduced_motion="reduce", device_scale_factor=1)
                app = context.new_page()
                errors = []
                app.on("pageerror", lambda error: errors.append(str(error)))
                app.goto(args.app)
                app.locator("button.primary[type=submit]").click()
                nav = app.get_by_role("navigation", name="Destinos")
                nav.wait_for()
                if project:
                    app.get_by_role("button", name=f"Abrir {project}", exact=True).first.click()
                label = "Flow" if name == "flow-demo" else name.capitalize()
                nav.get_by_role("button", name=f"{label} (", exact=False).click()
                if name == "flow-demo":
                    app.locator(".flow-demo").click()
                app.locator(selector).first.wait_for(state="visible")
                if name == "ajustes":
                    app.get_by_role("button", name="Skills y reglas", exact=True).click()
                if name == "entrega":
                    app.locator(".monaco.is-unified .monaco-editor").wait_for(state="visible")
                app.mouse.move(width - 2, height - 2)
                app.evaluate("document.fonts.ready")
                app.wait_for_timeout(300)
                stem = f"{name}-{width}x{height}"
                actual = args.output / f"{stem}.png"
                app.screenshot(path=actual, animations="disabled")
                result = {"view": name, "width": width, "height": height, "errors": errors}

                if artifact:
                    ref = context.new_page()
                    ref.goto(artifact.as_uri())
                    ref.evaluate("(view) => go(view)", view)
                    ref.locator("#view > :first-child").wait_for(state="visible")
                    if name == "ajustes":
                        ref.get_by_role("button", name="Skills y reglas", exact=True).click()
                    ref.evaluate("document.fonts.ready")
                    ref.wait_for_timeout(300)
                    reference = args.output / f"{stem}-artifact.png"
                    ref.screenshot(path=reference, animations="disabled")
                    diff = save_comparison(reference, actual, args.output / f"{stem}-comparativa.png",
                                           args.reference_label, f"Filigranas · simulación · {name}")
                    if args.diff:
                        diff.save(args.output / f"{stem}-diferencias.png")
                results.append(result)
                context.close()
        browser.close()
    (args.output / "capturas.json").write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    if any(result["errors"] for result in results):
        raise SystemExit("Error de JavaScript durante la captura. Consulta capturas.json.")


if __name__ == "__main__":
    main()
