"""Captura Trama en Chromium y, si se suministra el export v2, monta las comparativas."""

import argparse
import base64
import hashlib
import json
import re
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



CANONICAL = ROOT / "design/trama-v2/reference/index.html"


def canonical_resources(path):
    folder = path.parent
    manifest = json.loads((folder / "manifest.json").read_text())
    raw = path.read_bytes()

    def verify(data, expected, label):
        if hashlib.sha256(data).hexdigest() != expected:
            raise ValueError(f"El hash de {label} no coincide con la referencia")

    verify(raw, manifest["sha256"], path.name)
    for item in manifest["embedded"]:
        tag = item["kind"].encode()
        payload, = re.findall(rb"<" + tag + rb"(?:\s[^>]*)?>(.*?)</" + tag + rb">", raw, re.DOTALL)
        verify(payload, item["sha256"], item["kind"])
    files = {}
    for item in [manifest["fontStylesheet"], *manifest["resources"]]:
        file = folder / item["path"]
        verify(file.read_bytes(), item["sha256"], item["path"])
        if file.suffix in (".css", ".woff2"):
            files[item["source"]] = file
    return files


def open_reference(context, artifact, resources, view, name):
    ref = context.new_page()
    if resources:
        ref.route("https://**/*", lambda route: route.fulfill(
            path=resources[route.request.url], headers={"Access-Control-Allow-Origin": "*"}
        ) if route.request.url in resources else route.abort())
    ref.goto(artifact.as_uri())
    if not ref.evaluate("typeof go === 'function'"):
        raise ValueError("El export no expone la navegación de Trama")
    ref.evaluate("(view) => go(view)", view)
    ref.locator("#view > :first-child").wait_for(state="visible")
    if name == "ajustes":
        ref.get_by_role("button", name="Skills y reglas", exact=True).click()
    ref.evaluate("document.fonts.ready")
    return ref



def studio_fixture(page, output):
    output.mkdir(parents=True, exist_ok=True)
    fixture = page.evaluate("""() => ({
      versions: VERS.map(({n, note, ok}) => ({n, note, approved: ok, image: `v${n}.png`})),
      references: Array.from(document.querySelectorAll('canvas[data-ref]'))
        .map((canvas) => ({name: canvas.dataset.ref, data: canvas.toDataURL('image/png')})),
      header: COMPS.find((component) => component.id === 'hdr'),
    })""")
    for item in fixture["references"]:
        (output / f'{item["name"]}.png').write_bytes(base64.b64decode(item.pop("data").split(",", 1)[1]))
        item["image"] = f'{item["name"]}.png'
    for item in fixture["versions"]:
        page.evaluate("(n) => { S.studio.ver = n; S.studio.locks = []; S.studio.z = 1; go('studio'); }", item["n"])
        page.locator('#frm').screenshot(path=output / item["image"], animations="disabled")
    (output / "manifest.json").write_text(json.dumps(fixture, indent=2, ensure_ascii=False) + "\n")


def entrega_fixture(page, destination):
    fixture = page.evaluate("""() => {
      const path = (name) => name === 'git_ops.rs' ? 'src-tauri/src/git_ops.rs' : `src/${name}`;
      const files = Object.entries(CODE).map(([name, rows]) => ({
        path: path(name),
        before: rows.filter(([tag]) => tag !== 'a').map(([,text]) => text ?? '').join('\\n') + '\\n',
        after: rows.filter(([tag]) => tag !== 'd').map(([,text]) => text ?? '').join('\\n') + '\\n',
      }));
      const findings = FINDS.map((finding) => ({
        id: finding.id, path: path(finding.f), label: finding.t,
        line: CODE[finding.f].slice(0, finding.line + 1).filter(([tag]) => tag !== 'd').length,
        severity: { h: 'error', m: 'warning', l: 'note' }[finding.sev],
      }));
      return { files, findings };
    }""")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(fixture, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def workspace_fixture(page, destination):
    state = page.evaluate(r"""() => {
      if (!S.msgs) initMsgs();
      const [user, plan, architecture, , diff] = S.msgs.pm;
      const plain = (html) => {
        const node = document.createElement('div');
        node.innerHTML = html.replaceAll('<b>', '**').replaceAll('</b>', '**');
        return node.textContent;
      };
      go('workspace');
      const chart = Array.from(document.querySelectorAll('#archsvg g')).slice(0, 4).map((node) => {
        return Array.from(node.querySelectorAll('text')).map((label) => label.textContent);
      });
      const edgeLabel = document.querySelector('#archsvg g:last-child text').textContent;
      const title = document.querySelector('#archsvg').closest('.rich').querySelector('.rh b').textContent;
      const label = ([name, detail], index) => `n${index}["${name}<br/>${detail}"]`;
      const chartLines = chart.slice(1).map((node, i) =>
        `${i ? 'n' + i : label(chart[0], 0)} -->${i === 1 ? '|' + edgeLabel + '|' : ''} ${label(node, i + 1)}`);
      const code = CODE['git_ops.rs'].map(([kind, text = '']) => (kind === 'a' ? '+' : kind === 'd' ? '-' : ' ') + text);
      const patch = ['@@ -1 +1 @@', ...code].join('\n');
      return {
        tasks: TK.map(({id, title, status, deps, prio}) => ({id, title, status, deps, prio})),
        sessions: ['sen', 'cod', 'jun'].map((id) => {
          const agent = AG.find((entry) => entry.id === id);
          return { id, task: agent.task, name: agent.role, engine: agent.engine === 'Codex' ? 'codex' : 'claude', state: agent.state,
            items: S.msgs[id].filter((item) => item.k === 'ai' || item.k === 'brief').map((item, index) =>
              ({ id: id + '-' + index, type: 'agentMessage', text: plain(item.x), by: item.k === 'brief' ? 'Project manager' : agent.role })),
          };
        }),
        items: [
          {id:'request', type:'userMessage', content:[{type:'text',text:user.x}]},
          {id:'plan', type:'plan', text:plain(plan.x)},
          {id:'architecture', type:'agentMessage', text:[plain(architecture.x),'', '```mermaid','flowchart LR',
            'accTitle: ' + title, ...chartLines, '```'].join('\n'), by:'Project manager'},
          {id:'diff', type:'agentMessage', text:plain(diff.x), by:'Project manager'},
          {id:'git-change', type:'fileChange', status:'completed',
            changes:[{path:'src-tauri/src/git_ops.rs', kind:{type:'update'}, diff:patch}]}
        ]
      };
    }""")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(state, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

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
    parser.add_argument("--reference-only", action="store_true", help="Captura solo la referencia canónica")
    parser.add_argument("--workspace-fixture", type=Path, help="Exporta las tareas y la conversación del PM")
    parser.add_argument("--entrega-fixture", type=Path, help="Exporta los diffs y los hallazgos de Entrega")
    parser.add_argument("--studio-fixture", type=Path, help="Exporta los cuatro contenidos de lienzo y las referencias de Studio")
    parser.add_argument("--reference-label", default="Artifact de referencia")
    parser.add_argument("--output", type=Path, default=ROOT / "docs/trama-paridad/actual")
    parser.add_argument("--channel", default=None, help="Canal Chromium, por ejemplo chrome")
    parser.add_argument("--diff", action="store_true", help="Guardar diferencias de píxel para datos y estados previamente alineados")
    parser.add_argument("--section", action="append", choices=[item[0] for item in SECTIONS])
    parser.add_argument("--width", action="append", type=int, choices=[width for width, _ in SIZES])
    args = parser.parse_args()
    sections = [item for item in SECTIONS if not args.section or item[0] in args.section]
    sizes = [item for item in SIZES if not args.width or item[0] in args.width]

    if args.diff and (not args.artifact or args.reference_only):
        parser.error("--diff requiere dos capturas alineadas y --artifact")
    artifact = Path(args.artifact).expanduser().resolve(strict=True) if args.artifact else (
        CANONICAL if args.reference_only else None
    )
    resources = canonical_resources(artifact) if artifact == CANONICAL else {}
    if args.studio_fixture and (not args.reference_only or artifact != CANONICAL or sizes != [(1440, 900)] or not any(s[0] == "studio" for s in sections)):
        parser.error("--studio-fixture requiere la referencia canónica a 1440 y la sección Studio")
    if args.entrega_fixture and (not args.reference_only or artifact != CANONICAL or sizes != [(1440, 900)] or not any(s[0] == "entrega" for s in sections)):
        parser.error("--entrega-fixture requiere la referencia canónica a 1440 y la sección Entrega")
    if args.workspace_fixture and (not args.reference_only or artifact != CANONICAL or sizes != [(1440, 900)] or not any(s[0] == "workspace" for s in sections)):
        parser.error("--workspace-fixture requiere la referencia canónica a 1440 y Workspace")
    args.output.mkdir(parents=True, exist_ok=True)
    results = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel=args.channel)
        for width, height in sizes:
            for name, view, selector, project in sections:
                frame = {"width": width, "height": height}
                context = browser.new_context(viewport=frame, reduced_motion="reduce", device_scale_factor=1)
                stem = f"{name}-{width}x{height}"
                if args.reference_only:
                    ref = open_reference(context, artifact, resources, view, name)
                    ref.screenshot(path=args.output / f"{stem}-artifact.png", animations="disabled")
                    result = {"view": name, "width": width, "height": height, "errors": []}
                    if name == "flow":
                        result["scene"] = ref.evaluate("""() => ({
                          view: 'Flow', lens: S.flow.lens, selected: S.flow.sel,
                          nodes: flowNodes(S.flow.lens).nodes.map(({id, x, y}) => ({id, x, y}))
                            .sort((a, b) => a.id.localeCompare(b.id)),
                        })""")
                    if name == "studio" and args.studio_fixture:
                        studio_fixture(ref, args.studio_fixture)
                    if name == "entrega" and args.entrega_fixture:
                        entrega_fixture(ref, args.entrega_fixture)
                    if name == "workspace" and args.workspace_fixture:
                        workspace_fixture(ref, args.workspace_fixture)
                    results.append(result)
                    context.close()
                    continue
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
                if name == "brain":
                    app.get_by_role("button", name="Red del proyecto").click()
                    app.locator(".brain-network").wait_for(state="visible")
                if name == "ajustes":
                    app.get_by_role("button", name="Skills y reglas", exact=True).click()
                if name == "entrega":
                    app.locator(".monaco.is-unified .monaco-editor").wait_for(state="visible")
                app.mouse.move(width - 2, height - 2)
                app.evaluate("document.fonts.ready")
                app.wait_for_timeout(300)
                actual = args.output / f"{stem}.png"
                app.screenshot(path=actual, animations="disabled")
                result = {"view": name, "width": width, "height": height, "errors": errors}

                if artifact:
                    ref = open_reference(context, artifact, resources, view, name)
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
