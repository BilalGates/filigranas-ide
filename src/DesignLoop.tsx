import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { design, type DesignRegion, type DesignScreen, type DesignShot, type Session } from './ipc';

const EMPTY: DesignScreen = { id: null, name: '', url: '', constraints: '', revision: null, approved: null };
const FULL: DesignRegion = { x: 0, y: 0, width: 100, height: 100 };
const STATUSES: Record<string, string> = { candidate: 'candidata', approved: 'aprobada', discarded: 'descartada' };

type Props = { project: string; sessions: Session[]; hidden: boolean; onNew: () => void; onSession: (id: number) => void };
type Images = { selected: number; reference: number | null; candidate: string; baseline: string | null };

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('No se pudo leer el PNG'));
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(file);
  });
}

export default function DesignLoop({ project, sessions, hidden, onNew, onSession }: Props) {
  const [screens, setScreens] = useState<DesignScreen[]>([]);
  const [screenId, setScreenId] = useState<number | null>(null);
  const [form, setForm] = useState<DesignScreen>(EMPTY);
  const [shots, setShots] = useState<DesignShot[]>([]);
  const [shotId, setShotId] = useState<number | null>(null);
  const [images, setImages] = useState<Images>();
  const [width, setWidth] = useState(1280);
  const [height, setHeight] = useState(800);
  const [note, setNote] = useState('');
  const [region, setRegion] = useState<DesignRegion>(FULL);
  const [confirmed, setConfirmed] = useState(false);
  const [share, setShare] = useState(false);
  const [wipe, setWipe] = useState<number | null>(null);
  const [agent, setAgent] = useState<number | null>(null);
  const [request, setRequest] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const screen = screens.find((s) => s.id === screenId);
  const shot = shots.find((s) => s.id === shotId);
  const baseline = shots.find((s) => s.id === screen?.approved);
  const sameSize = !!(baseline && shot && baseline.width === shot.width && baseline.height === shot.height);
  const designer = sessions.filter((s) => s.engine === 'claude' && s.worktree);
  const imagePair = images?.selected === shotId && images?.reference === (baseline?.id ?? null) ? images : undefined;
  const canReview = shot?.status === 'candidate' && !!imagePair && (!baseline || sameSize);
  const validRegion = region.width > 0 && region.height > 0 && region.x + region.width <= 100 && region.y + region.height <= 100;

  useEffect(() => {
    if (hidden) return;
    let active = true;
    design.list(project).then((items) => { if (active) setScreens(items); }, (e) => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [project, hidden]);

  useEffect(() => {
    setConfirmed(false);
    setShare(false);
    setRegion(FULL);
    setWipe(null);
  }, [screenId, shotId, screen?.approved, screen?.revision]);

  useEffect(() => {
    if (screenId == null || shotId == null) return;
    let active = true;
    const reference = baseline?.id ?? null;
    const read = (id: number) => design.image(project, screenId, id).then((base64) => `data:image/png;base64,${base64}`);
    Promise.all([read(shotId), reference != null && reference !== shotId ? read(reference) : Promise.resolve(null)]).then(
      ([candidate, base]) => { if (active) setImages({ selected: shotId, reference, candidate, baseline: base }); },
      (e) => { if (active) setError(String(e)); },
    );
    return () => { active = false; };
  }, [project, screenId, shotId, baseline?.id]);

  const act = async (run: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try { await run(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const loadShots = async (id: number, select?: number) => {
    const items = await design.shots(project, id);
    setShots(items);
    setShotId(select ?? items[0]?.id ?? null);
  };
  const choose = (id: number | null) => {
    const item = screens.find((s) => s.id === id);
    setForm(item ?? EMPTY);
    setScreenId(id);
    setShotId(null);
    setShots([]);
    setNote('');
    if (id != null) void act(() => loadShots(id));
  };
  const refreshScreen = async (id: number) => {
    const next = await design.list(project);
    setScreens(next);
    setForm(next.find((s) => s.id === id) ?? EMPTY);
  };
  const save = () => act(async () => {
    const id = await design.save(project, form);
    await refreshScreen(id);
    setScreenId(id);
    await loadShots(id, shotId ?? undefined);
  });
  const importPng = (file: File) => {
    if (screenId == null) return;
    void act(async () => {
      if (file.size > 4 * 1024 * 1024) throw new Error('La captura PNG supera 4 MiB');
      const id = await design.import(project, screenId, await fileBase64(file), note);
      await loadShots(screenId, id);
      setNote('');
    });
  };
  const review = (approve: boolean) => {
    if (!screen || screen.id == null || screen.revision == null || !shot) return;
    const { id, approved, revision } = screen;
    void act(async () => {
      await design.review(project, id, { shot: shot.id, baseline: approved, revision, approve, confirmed });
      setConfirmed(false);
      await refreshScreen(id);
      await loadShots(id, shot.id);
    });
  };
  const send = (compare: boolean) => {
    if (screenId == null || shotId == null || agent == null) return;
    void act(async () => {
      await design.send(project, { session: agent, screen: screenId, shot: shotId, region, request, compare, confirmed: share });
      setShare(false);
      onSession(agent);
    });
  };

  return <section className="coach" aria-label="Design Loop" hidden={hidden}>
    <header className="co-head"><span>Design Loop</span></header>
    <div className="co-log p5-panel">
      {error && <p className="co-error" role="alert">{error}</p>}
      <form className="task-form p5-section" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="p5-actions">
          <label>Pantalla<select disabled={busy} value={screenId ?? ''} onChange={(e) => choose(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Nueva pantalla</option>
            {screens.map((s) => <option key={s.id} value={s.id!}>{s.name}</option>)}
          </select></label>
          <label>Nombre<input required maxLength={100} value={form.name} disabled={busy}
            onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label>URL local de vista previa<input type="url" placeholder="http://localhost:3000" value={form.url} disabled={busy}
            onChange={(e) => setForm({ ...form, url: e.target.value })} /></label>
        </div>
        <label>Restricciones bloqueadas
          <textarea value={form.constraints} disabled={busy} maxLength={6000}
            placeholder="Elementos que deben conservarse, medidas, tipografía y accesibilidad"
            onChange={(e) => setForm({ ...form, constraints: e.target.value })} />
        </label>
        <div className="p5-actions">
          <button className="co-btn" disabled={busy}>Guardar pantalla y restricciones</button>
          {screenId != null && screen?.url && <button type="button" className="co-btn" disabled={busy}
            onClick={() => void act(() => design.preview(project, screenId))}>Abrir vista previa en el navegador</button>}
        </div>
      </form>

      {screenId != null && <section className="p5-section" aria-label="Capturas de diseño">
        <h2>Capturas</h2>
        <div className="task-form p5-actions">
          {screen?.url && <>
            <label>Ancho<input type="number" value={width} step={1} min={64} max={4096} disabled={busy} onChange={(e) => setWidth(e.target.valueAsNumber || 0)} /></label>
            <label>Alto<input type="number" value={height} step={1} min={64} max={4096} disabled={busy} onChange={(e) => setHeight(e.target.valueAsNumber || 0)} /></label>
          </>}
          <label>Nota de versión<input value={note} maxLength={900} disabled={busy} onChange={(e) => setNote(e.target.value)} /></label>
          {screen?.url && <button className="co-btn" disabled={busy || !Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 64 || width > 4096 || height > 4096}
            onClick={() => void act(async () => {
              const id = await design.capture(project, screenId, width, height, note);
              await loadShots(screenId, id);
              setNote('');
            })}>Capturar con Chrome</button>}
          <label className="co-btn p5-upload">Importar PNG
            <input type="file" accept=".png,image/png" disabled={busy} onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = '';
              if (file) importPng(file);
            }} />
          </label>
        </div>
        {shots.length === 0 && <p className="muted">Guarda una primera captura para establecer la referencia.</p>}
        {!!shots.length && <div className="task-form p5-actions">
          <label>Versión<select value={shotId ?? ''} disabled={busy} onChange={(e) => setShotId(Number(e.target.value))}>
            {shots.map((s) => <option key={s.id} value={s.id}>#{s.id} · {STATUSES[s.status]} · {s.width} × {s.height} · {s.note || s.source}</option>)}
          </select></label>
        </div>}
        {shot && <p className="muted">{shot.url ?? shot.source} · {new Date(shot.observed * 1000).toLocaleString()}</p>}
        {baseline && shot && baseline.id !== shot.id && !sameSize && <p role="status">Usa el mismo tamaño que la referencia, {baseline.width} × {baseline.height}.</p>}

        {shot && imagePair && <>
          <div className="design-comparison">
            {imagePair.baseline && <figure><figcaption>Referencia #{baseline?.id}</figcaption>
              <img src={imagePair.baseline} alt="Referencia aprobada" /></figure>}
            <figure><figcaption>Versión #{shot.id}. Arrastra para elegir una región.</figcaption>
              <RegionImage image={imagePair.candidate} region={region} onChange={setRegion} />
            </figure>
          </div>
          <div className="task-form p5-actions">
            {(['x', 'y', 'width', 'height'] as const).map((key) => <label key={key}>{({ x: 'X', y: 'Y', width: 'Ancho', height: 'Alto' })[key]} %
              <input type="number" min={key === 'x' || key === 'y' ? 0 : 1} max={100} value={region[key]} onChange={(e) => {
                const value = Math.max(0, Math.min(100, Math.round(e.target.valueAsNumber || 0)));
                setRegion((old) => ({ ...old, [key]: value }));
              }} />
            </label>)}
            <button className="co-btn" onClick={() => setRegion(FULL)}>Pantalla completa</button>
          </div>
          {!validRegion && <p role="status">La región debe quedar dentro de la pantalla.</p>}
          {sameSize && baseline && imagePair.baseline && validRegion && <section className="design-wipe" aria-label="Comparación de la región">
            <label>Comparación de la región · candidata {wipe ?? 50} %
              <input type="range" min={0} max={100} value={wipe ?? 50} onChange={(e) => setWipe(Number(e.target.value))} />
            </label>
            <div className="design-crop" style={{ aspectRatio: (shot.width * region.width) / (shot.height * region.height) }}>
              <Crop image={imagePair.baseline} region={region} label="Referencia de la región" />
              <div className="design-crop-layer" style={{ clipPath: `inset(0 ${100 - (wipe ?? 50)}% 0 0)` }}>
                <Crop image={imagePair.candidate} region={region} label="Candidata de la región" />
              </div>
            </div>
          </section>}
          {shot.status === 'candidate' && <div className="p5-actions">
            <label className="p5-check"><input type="checkbox" checked={confirmed} disabled={busy || !canReview}
              onChange={(e) => setConfirmed(e.target.checked)} /> Revisé la captura y conserva las restricciones bloqueadas</label>
            <button className="co-btn" disabled={busy || !confirmed || !canReview} onClick={() => review(true)}>{baseline ? 'Aprobar versión' : 'Aprobar referencia'}</button>
            <button className="co-btn" disabled={busy} onClick={() => review(false)}>Descartar candidata</button>
          </div>}
        </>}
      </section>}

      {shot && screenId != null && <section className="p5-section task-form" aria-label="Sesión de diseño">
        <h2>Sesión de diseño</h2>
        <div className="p5-actions">
          <label>Sesión Claude<select value={agent ?? ''} disabled={busy} onChange={(e) => { setAgent(e.target.value ? Number(e.target.value) : null); setShare(false); }}>
            <option value="">Elige una sesión aislada</option>
            {designer.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.branch}</option>)}
          </select></label>
          <button className="co-btn" disabled={busy} onClick={onNew}>Abrir sesión Claude</button>
        </div>
        <label>Encargo para la región<textarea value={request} disabled={busy} maxLength={3000} onChange={(e) => setRequest(e.target.value)} /></label>
        <label className="p5-check"><input type="checkbox" checked={share} disabled={busy}
          onChange={(e) => setShare(e.target.checked)} /> Autorizo enviar las capturas seleccionadas y las restricciones a esta sesión Claude</label>
        <div className="p5-actions">
          <button className="co-btn" disabled={busy || !share || !validRegion || !request.trim() || !designer.some((s) => s.id === agent)}
            onClick={() => send(false)}>Enviar encargo</button>
          <button className="co-btn" disabled={busy || !share || !validRegion || !request.trim() || !sameSize || !imagePair?.baseline || !designer.some((s) => s.id === agent)}
            onClick={() => send(true)}>Pedir comparación visual</button>
        </div>
      </section>}
    </div>
  </section>;
}

function RegionImage({ image, region, onChange }: { image: string; region: DesignRegion; onChange: (r: DesignRegion) => void }) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const point = (e: PointerEvent<HTMLDivElement>) => {
    const bounds = e.currentTarget.getBoundingClientRect();
    const percent = (value: number, length: number) => Math.round(100 * Math.max(0, Math.min(1, value / length)));
    return { x: percent(e.clientX - bounds.left, bounds.width), y: percent(e.clientY - bounds.top, bounds.height) };
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const p = point(e);
    const x = Math.min(p.x, start.current.x, 99);
    const y = Math.min(p.y, start.current.y, 99);
    onChange({ x, y, width: Math.max(1, Math.abs(p.x - start.current.x)), height: Math.max(1, Math.abs(p.y - start.current.y)) });
  };
  return <div className="design-region" onPointerDown={(e) => {
    if (e.button !== 0) return;
    start.current = point(e);
    e.currentTarget.setPointerCapture(e.pointerId);
  }} onPointerMove={move} onPointerUp={(e) => { move(e); start.current = null; }}
    onPointerCancel={() => { start.current = null; }}>
    <img src={image} alt="Captura de la versión seleccionada" draggable={false} />
    <div aria-hidden="true" className="design-region-outline"
      style={{ left: `${region.x}%`, top: `${region.y}%`, width: `${region.width}%`, height: `${region.height}%` }} />
  </div>;
}

function Crop({ image, region, label }: { image: string; region: DesignRegion; label: string }) {
  return <img src={image} alt={label} style={{
    width: `${10000 / region.width}%`, maxWidth: 'none',
    left: `${-100 * region.x / region.width}%`, top: `${-100 * region.y / region.height}%`,
  }} />;
}
