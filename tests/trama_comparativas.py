"""Prepara Git sintético y captura las dos páginas en una misma ventana de Filigranas."""
import argparse
import datetime
import json
import os
import re
import subprocess
import sqlite3
import time
from pathlib import Path
from urllib.request import urlopen

from PIL import Image, ImageChops, ImageDraw
from trama_semaforo import WINDOW

BASE_VIEWS = ("inicio", "workspace", "flow", "studio", "entrega", "brain", "ajustes")
VIEWS = ("inicio", "workspace", "workspace-arquitectura", "workspace-observar", "workspace-permiso", "flow", "flow-dependencias",
         "studio", "studio-comparacion", "entrega", "entrega-hallazgo", "entrega-ci", "brain", "brain-agrupado", "brain-inferencias", "ajustes")


def prepare(root, workspace_db=None):
    if not re.fullmatch(r"/(?:private/)?tmp/trama-escenas-[^/]+/repos", str(root)):
        raise ValueError("Se requiere una raíz temporal de escenas")
    with urlopen("http://127.0.0.1:14572/__trama_fixtures", timeout=5) as response:
        projects = json.load(response)["projects"]
    today = datetime.datetime.now().astimezone().replace(hour=12, minute=0, second=0, microsecond=0)
    for item in projects:
        project = root / item["n"]
        if project.exists():
            continue
        project.mkdir()
        subprocess.run(["git", "init", "-q", "-b", item["br"], project], check=True)
        commits = []
        for i, count in enumerate(item["act"]):
            date = int((today - datetime.timedelta(days=20-i)).timestamp())
            for index in range(count):
                message = f"Actividad de prueba {i}-{index}"
                commits.append(
                    f"commit refs/heads/{item['br']}\n"
                    f"committer Trama <trama@example.invalid> {min(date, int(time.time()))} +0000\n"
                    f"data {len(message)}\n{message}\n\n"
                )
        if commits:
            subprocess.run(["git", "-C", project, "fast-import", "--quiet"], input="".join(commits), text=True, check=True)


    if workspace_db:
        prepare_workspace(root / "filigranas-ide", workspace_db)
        observe_ci(workspace_db, root / "kaza", number=16, state="failure", counts=[13, 1, 0])
        observe_ci(workspace_db, root / "kaza", number=99, state="success", counts=[14, 0, 0], wrong_sha=True)


def prepare_workspace(project, db):
    fixture = json.loads(Path("docs/trama-aceptacion-final/evidencias/fixture-workspace.json").read_text())
    expected = Path.home() / "Library/Application Support/com.filigranas.ide.trama-escenas/filigranas.db"
    if db.resolve() != expected.resolve() or not db.is_file():
        raise ValueError("Solo se admite la base existente del perfil aislado de escenas")
    with sqlite3.connect(db) as conn:
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("DELETE FROM github_pulls WHERE project=? AND repository=? AND number=17",
                     (str(project), "trama-prueba/filigranas-ide"))
        task_ids = dict(conn.execute("SELECT title,id FROM tasks WHERE project=?", (str(project),)))
        if len(task_ids) != 8 or set(task_ids) != {item["title"] for item in fixture["tasks"]}:
            raise ValueError("El proyecto temporal debe contener las ocho tareas del Artifact")
        tasks = {item["id"]: item["title"] for item in fixture["tasks"]}
        conn.execute(
            "INSERT INTO chat_history(scope,items) VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET items=excluded.items",
            ("pm:" + str(project), json.dumps(fixture["items"], ensure_ascii=False)),
        )
        for session in fixture["sessions"]:
            alias = "trama-fixture-" + session["id"]
            row = conn.execute(
                "SELECT id FROM sessions WHERE project=? AND provider_session=?", (str(project), alias),
            ).fetchone()
            if row:
                session_id = row[0]
            else:
                session_id = conn.execute(
                    "INSERT INTO sessions(project,engine,name,provider_session,task) VALUES(?,?,?,?,?)",
                    (str(project), session["engine"], session["name"], alias, tasks[session["task"]]),
                ).lastrowid
            conn.execute(
                "INSERT INTO task_sessions(session_id,task_id) VALUES(?,?) ON CONFLICT(session_id) DO NOTHING",
                (session_id, task_ids[tasks[session["task"]]]),
            )
            conn.execute(
                "INSERT INTO chat_history(scope,items) VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET items=excluded.items",
                ("session:" + str(session_id), json.dumps(session["items"], ensure_ascii=False)),
            )


def observe_ci(db, project, *, number, state, counts, wrong_sha=False):
    if not re.fullmatch(r"/(?:private/)?tmp/trama-escenas-[^/]+/repos/(kaza|filigranas-ide)", str(project)):
        raise ValueError("El CI de prueba requiere un repositorio sintético")
    expected = Path.home() / "Library/Application Support/com.filigranas.ide.trama-escenas/filigranas.db"
    if db.resolve() != expected.resolve() or not db.is_file():
        raise ValueError("El CI de prueba requiere la base aislada")
    branch = subprocess.check_output(["git", "-C", project, "branch", "--show-current"], text=True).strip()
    head = subprocess.check_output(["git", "-C", project, "rev-parse", "HEAD"], text=True).strip()
    repository = f"trama-prueba/{project.name}"
    snapshot = dict(number=number, url=f"https://github.com/{repository}/pull/{number}", state="OPEN",
                    isDraft=False, branch=branch, base="main", head="0"*40 if wrong_sha else head,
                    checks=counts, checksState=state, checksKnown=True, review="APPROVED", mergeState="CLEAN",
                    observedAt=int(time.time()))
    with sqlite3.connect(db) as conn:
        conn.execute(
            """INSERT INTO github_pulls(project,repository,branch,number,snapshot)
               VALUES(?,?,?,?,?) ON CONFLICT(project,repository,number) DO UPDATE SET
               snapshot=excluded.snapshot, observed_at=unixepoch()""",
            (str(project), repository, branch, number, json.dumps(snapshot)),
        )


def take(pid, output, workspace_db=None):
    process = subprocess.check_output(["ps", "-p", str(pid), "-o", "comm="], text=True).strip()
    if "/target/debug/filigranas" not in process:
        raise ValueError("Se requiere el ejecutable de desarrollo")
    locate = WINDOW.replace(
        "w.kCGWindowLayer === 0",
        "w.kCGWindowBounds.Width >= 900 && w.kCGWindowBounds.Height >= 600",
    )
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        result = subprocess.run(
            ["osascript", "-l", "JavaScript", "-", str(pid), "1440", "900", "0"],
            input=locate,
            text=True, capture_output=True, timeout=8,
        )
        if result.returncode == 0:
            window = json.loads(result.stdout)
            break
        time.sleep(0.2)
    else:
        raise RuntimeError(f"No se pudo activar la ventana de pruebas: {result.stderr.strip()}")
    deadline = time.monotonic() + 180
    completed = {}
    while time.monotonic() < deadline:
        state = output / "escena.json"
        if not state.exists():
            time.sleep(0.15)
            continue
        report = json.loads(state.read_text())
        if report.get("error"):
            raise RuntimeError(report["error"])
        side, scene = report["side"], report["ready"]
        if scene == "fin":
            if side not in completed:
                completed[side] = report
                (output / f"{side}.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))
            if set(completed) == {"native", "artifact"}:
                return completed
        elif scene in VIEWS:
            shot = output / f"{side}-{scene}.png"
            if not shot.exists():
                partial = output / "capturando.png"
                subprocess.run(["screencapture", "-x", "-o", "-l", str(window["id"]), partial], check=True)
                if workspace_db and side == "native" and scene == "entrega-hallazgo":
                    root = Path(os.environ["VITE_TRAMA_SCENE_ROOT"])
                    observe_ci(workspace_db, root / "filigranas-ide", number=17, state="success", counts=[14, 0, 0])
                partial.rename(shot)
                print(shot.name, flush=True)
        time.sleep(0.15)
    raise TimeoutError("El recorrido nativo no finalizó")


def compare(output, reports):
    results = {}
    for view in VIEWS:
        reference = Image.open(output / f"artifact-{view}.png").convert("RGB")
        native = Image.open(output / f"native-{view}.png").convert("RGB")
        ref_state = reports["artifact"]["views"][view]
        native_state = reports["native"]["views"][view]
        assert reference.size == native.size and ref_state["viewport"] == native_state["viewport"]
        scale = ref_state["viewport"]["scale"]
        assert reference.size == (round(ref_state["viewport"]["width"]*scale), round(ref_state["viewport"]["height"]*scale))
        # Compara la intersección de las superficies de trabajo en las mismas
        # coordenadas de ventana. El marco nativo y el riel quedan en las tomas.
        a, b = ref_state["body"], native_state["body"]
        region = tuple(round(scale * value) for value in (
            max(a["x"], b["x"]), max(a["y"], b["y"]),
            min(a["x"] + a["width"], b["x"] + b["width"]),
            min(a["y"] + a["height"], b["y"] + b["height"]),
        ))
        original, actual = reference.crop(region), native.crop(region)
        diff = ImageChops.difference(original, actual)
        max_channel = ImageChops.lighter(ImageChops.lighter(diff.getchannel("R"), diff.getchannel("G")), diff.getchannel("B"))
        histogram = max_channel.histogram()
        pixels = original.width * original.height
        results[view] = {
            "region": region, "pixels": pixels, "different": pixels - histogram[0],
            "deltaGreaterThan12": sum(histogram[13:]),
        }
        Image.blend(original, actual, 0.5).save(output / f"{view}-superposicion.webp", lossless=True)
        diff.point(lambda value: min(value * 3, 255)).save(output / f"{view}-diferencias.webp", lossless=True)
        montage = Image.new("RGB", (reference.width * 2, reference.height + 32), "#16191e")
        montage.paste(reference, (0, 32))
        montage.paste(native, (reference.width, 32))
        labels = ImageDraw.Draw(montage)
        labels.text((12, 11), "HTML aprobado en WKWebView", fill="white")
        labels.text((reference.width + 12, 11), "Filigranas nativa en WKWebView", fill="white")
        montage.save(output / f"{view}-comparativa.webp", lossless=True)
    (output / "pixeles.json").write_text(json.dumps(results, indent=2) + "\n")
    return results


def verify(reports):
    expected = reports["artifact"]["views"]["inicio"]["sigils"]
    actual = reports["native"]["views"]["inicio"]["sigils"]
    if len(expected) != 9 or actual != expected:
        raise RuntimeError("Los nueve sigilos deberían coincidir en los cuatro canales")
    for name in BASE_VIEWS:
        view = reports["native"]["views"][name]
        samples = view["active"]
        if len(samples) != 3 or any(sample["routeMs"] is None for sample in samples):
            raise RuntimeError(f"La transición de {name} no alcanzó su opacidad final en todas las vueltas")
    reference = reports["artifact"]["views"]
    native = reports["native"]["views"]
    for field in ("architecture", "changes"):
        if native["workspace"][field] != reference["workspace"][field]:
            raise RuntimeError(f"Workspace no coincide en {field}")
    if len(native["workspace"]["team"]) != reference["workspace"]["team"]:
        raise RuntimeError("El número de sesiones en las tarjetas de Workspace difiere")
    if not native["workspace-observar"]["readOnly"]:
        raise RuntimeError("La observación permite escribir en el hilo")
    assert native["workspace-observar"]["codeVisible"] and reference["workspace-observar"]["codeVisible"]
    for field in ("candidates", "timeline"):
        if native["flow"][field] != reference["flow"][field]:
            raise RuntimeError(f"Flow no coincide en {field}")
    if [entry["value"] for entry in reports["native"]["motion"]] != ["completo", "sin-ambiente", "reducido"]:
        raise RuntimeError("Falta comprobar algún modo de movimiento")
    assert native["workspace-permiso"]["decision"] == "decline"
    for field in ("source", "command", "actions"):
        assert native["workspace-permiso"][field] == reference["workspace-permiso"][field]
    assert native["inicio"]["failure"]["project"] == "kaza"
    assert native["inicio"]["failure"]["number"] == 16
    assert native["inicio"]["failure"]["actionOpensCi"]
    assert native["entrega-ci"]["checks"] == reference["entrega-ci"]["checks"] == [14, 0, 0]
    assert native["entrega-ci"]["codeVisible"] and reference["entrega-ci"]["codeVisible"]
    assert native["brain-inferencias"]["count"] == reference["brain-inferencias"]["count"] == 3
    assert native["brain-inferencias"]["approvedOnlyAfterConfirmation"]
    assert native["brain-inferencias"]["correctedWhilePending"]
    print("Nueve sigilos idénticos, tarjetas e inspector contrastados, tres modos y 21 transiciones completadas")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepare", type=Path)
    parser.add_argument("--workspace-db", type=Path, help="siembra el historial y los vínculos en el perfil aislado ya inicializado")
    parser.add_argument("--pid", type=int)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--verify", action="store_true", help="verifica los informes ya capturados")
    args = parser.parse_args()
    if args.prepare is not None:
        prepare(args.prepare, args.workspace_db)
    elif args.output and args.verify:
        verify({side: json.loads((args.output / f"{side}.json").read_text()) for side in ("native", "artifact")})
    elif args.pid and args.output:
        reports = take(args.pid, args.output, args.workspace_db)
        compare(args.output, reports)
        verify(reports)
    else:
        parser.error("indica --prepare, o bien --output con --pid o --verify")


if __name__ == "__main__":
    main()
