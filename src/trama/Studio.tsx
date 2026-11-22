import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { design, sessions as sessionApi, type DesignRegion, type DesignScreen, type DesignShot, type Session } from '../ipc';
import { Icon } from './icons';
import { Empty, ErrorNote, Modal, Seg } from './ui';

// Studio: el estudio de diseño sobre la infraestructura existente (pantallas,
// capturas, versiones, revisión y envío a una sesión Claude con worktree).
// Los bloqueos se guardan en las restricciones de la pantalla, que el núcleo
// incluye en cada encargo; así se respetan de verdad y quedan versionados.
// Enviar un encargo no cambia nada aquí: la sesión trabaja en su worktree y
// la nueva versión solo aparece cuando se captura o importa.
import { joinConstraints, parseConstraints, type Lock } from './constraints';
type Compare = 'una' | 'lado' | 'cortinilla' | 'diferencia';
type Tool = 'mover' | 'region';
const FULL: DesignRegion = { x: 0, y: 0, width: 100, height: 100 };
const fileBase64 = (file: File) => new Promise<string>((ok, ko) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result).split(',')[1] ?? '');
  r.onerror = () => ko(r.error);
  r.readAsDataURL(file);
});
const STATUS: Record<string, string> = { candidate: 'candidata', approved: 'aprobada', discarded: 'descartada' };

export default function Studio({ project, projectName, agentSessions, onOpenSession, onBrowser }: {
  project: string | null;
  projectName: string | null;
  agentSessions: Session[];
  onOpenSession: (id: number) => void;
  onBrowser: () => void;
}) {
  const [screens, setScreens] = useState<DesignScreen[] | null>(null);
  const [screenId, setScreenId] = useState<number | null>(null);
  const [shots, setShots] = useState<DesignShot[] | null>(null);
  const [shotId, setShotId] = useState<number | null>(null);
  const [images, setImages] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [region, setRegion] = useState<DesignRegion>(FULL);
  const [tool, setTool] = useState<Tool>('region');
  const [compare, setCompare] = useState<Compare>('una');
  const [editing, setEditing] = useState<DesignScreen | null>(null);
  const screen = screens?.find((s) => s.id === screenId) ?? null;
  const shot = shots?.find((s) => s.id === shotId) ?? null;
  const baseline = screen?.approved != null ? shots?.find((s) => s.id === screen.approved) ?? null : null;
  const parsed = useMemo(() => parseConstraints(screen?.constraints ?? ''), [screen?.constraints]);

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true); setError(null); setNotice(null);
    try { await fn(); if (done) setNotice(done); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const loadScreens = useCallback(async () => {
    if (!project) return;
    try { const list = await design.list(project); setScreens(list); setScreenId((id) => id ?? list[0]?.id ?? null); } catch (e) { setError(String(e)); }
  }, [project]);
  const loadShots = useCallback(async (id: number) => {
    if (!project) return;
    const list = await design.shots(project, id);
    setShots(list);
    setShotId((cur) => list.some((s) => s.id === cur) ? cur : list.find((s) => s.status === 'candidate')?.id ?? list[0]?.id ?? null);
  }, [project]);
  useEffect(() => { setScreens(null); setScreenId(null); setShots(null); setImages({}); void loadScreens(); }, [loadScreens]);
  useEffect(() => { if (screenId != null) loadShots(screenId).catch((e) => setError(String(e))); else setShots(null); }, [screenId, loadShots]);
  useEffect(() => {
    if (!project || screenId == null) return;
    for (const id of [shotId, baseline?.id]) {
      if (id == null || images[id]) continue;
      design.image(project, screenId, id).then((b) => setImages((m) => ({ ...m, [id]: `data:image/png;base64,${b}` })), (e) => setError(String(e)));
    }
  }, [project, screenId, shotId, baseline?.id, images]);

  const saveConstraints = (locks: Lock[], rest: string) => act(async () => {
    if (!project || !screen) return;
    await design.save(project, { ...screen, constraints: joinConstraints(locks, rest) });
    await loadScreens();
  }, 'Restricciones guardadas. Se incluirán en cada encargo de esta pantalla.');

  if (!project) return <section className="tr-dest" aria-label="Studio"><Empty icon="studio" title="Elige un proyecto">Studio trabaja sobre las pantallas de diseño del proyecto abierto.</Empty></section>;
  return (
    <section className="tr-dest tr-studio" aria-label="Studio">
      <header className="tr-head">
        <div><h1>Studio</h1><div className="sub">{projectName} · {screens ? `${screens.length} pantallas` : 'cargando…'}</div></div>
        <span className="grow" />
        {screen && <button className="tr-btn sm" onClick={() => act(async () => { await design.preview(project, screen.id!); onBrowser(); })} title="Abre la URL en el navegador integrado"><Icon name="globe" size={13} /> Vista previa</button>}
        <button className="tr-btn sm" onClick={() => setEditing({ id: null, name: '', url: '', constraints: '', revision: null, approved: null })}><Icon name="plus" size={13} /> Pantalla</button>
      </header>
      {(error || notice) && <div style={{ padding: '10px 18px 0' }}>{error ? <ErrorNote error={error} /> : <div className="tr-note" role="status"><Icon name="check" size={14} />{notice}</div>}</div>}
      {screens && screens.length === 0 ? (
        <Empty icon="studio" title="Sin pantallas de diseño" action={<button className="tr-btn pearl" onClick={() => setEditing({ id: null, name: '', url: '', constraints: '', revision: null, approved: null })}>Crear la primera pantalla</button>}>
          Una pantalla es una URL de tu proyecto. Captúrala, marca regiones, bloquea lo que no debe cambiar y encarga cambios a una sesión Claude.
        </Empty>
      ) : (
        <div className="studio-grid">
          <aside className="studio-side" aria-label="Pantallas y versiones">
            <div className="tr-lab" style={{ padding: '12px 12px 0' }}>Pantallas</div>
            <ul className="tr-list" style={{ padding: 6 }}>
              {(screens ?? []).map((s) => (
                <li key={s.id}><button className="tr-li" aria-selected={s.id === screenId} onClick={() => { setScreenId(s.id); setRegion(FULL); }}>
                  <Icon name="screen" size={13} /><span className="t">{s.name}</span>{s.approved != null && <span className="meta"><Icon name="check" size={11} /></span>}
                </button></li>
              ))}
            </ul>
            {screen && <>
              <div className="tr-row" style={{ padding: '6px 12px 0' }}><span className="tr-lab" style={{ margin: 0 }}>Versiones</span><span className="grow" />
                <button className="tr-btn sm ghost icon" title="Editar pantalla" aria-label="Editar pantalla" onClick={() => setEditing(screen)}><Icon name="edit" size={13} /></button></div>
              <Versions shots={shots} selected={shotId} approved={screen.approved} onSelect={setShotId} />
              <Capture busy={busy} onCapture={(w, h, note) => act(async () => { const id = await design.capture(project, screen.id!, w, h, note); await loadShots(screen.id!); setShotId(id); }, 'Captura guardada como candidata.')}
                onImport={(file, note) => act(async () => { const id = await design.import(project, screen.id!, await fileBase64(file), note); await loadShots(screen.id!); setShotId(id); }, 'Imagen importada como candidata.')} />
            </>}
          </aside>
          <div className="studio-canvas-wrap">
            <div className="studio-tools">
              <Seg label="Herramienta" value={tool} onChange={setTool} items={[{ id: 'mover', label: 'Mover', icon: 'hand' }, { id: 'region', label: 'Región', icon: 'region' }]} />
              <Seg label="Comparación" value={compare} onChange={setCompare} items={[{ id: 'una', label: 'Única', icon: 'image' }, { id: 'lado', label: 'Lado a lado', icon: 'side' }, { id: 'cortinilla', label: 'Cortinilla', icon: 'compare' }, { id: 'diferencia', label: 'Diferencia', icon: 'diff' }]} />
              <span className="grow" />
              <span className="mono mut" style={{ fontSize: 11 }}>región {Math.round(region.x)},{Math.round(region.y)} · {Math.round(region.width)}×{Math.round(region.height)} %</span>
              <button className="tr-btn sm ghost" onClick={() => setRegion(FULL)}>Toda la pantalla</button>
            </div>
            {!shot ? <Empty icon="image" title="Sin capturas">Captura la URL de la pantalla o importa una imagen para empezar.</Empty> : (
              <Canvas key={`${screenId}`} shot={shot} image={images[shot.id]} base={baseline && baseline.id !== shot.id ? images[baseline.id] : undefined}
                compare={compare} tool={tool} region={region} onRegion={setRegion} locks={parsed.locks} />
            )}
          </div>
          {screen && (
            <Inspector key={screen.id} project={project} screen={screen} shot={shot} baseline={baseline} region={region} parsed={parsed} busy={busy}
              agentSessions={agentSessions} onOpenSession={onOpenSession} onSaveConstraints={saveConstraints} onRegion={setRegion}
              onReview={(approve, confirmed) => act(async () => {
                await design.review(project, screen.id!, { shot: shot!.id, baseline: screen.approved, revision: screen.revision ?? 0, approve, confirmed });
                await loadScreens(); await loadShots(screen.id!);
              }, approve ? 'Versión aprobada como referencia.' : 'Versión descartada.')}
              onSend={(session, request, cmp) => act(() => design.send(project, { session, screen: screen.id!, shot: shot!.id, region, request, compare: cmp, confirmed: true }),
                cmp ? 'Comparación enviada. La respuesta llegará a la conversación de la sesión.' : 'Encargo enviado a la sesión. Captura de nuevo cuando termine para ver la nueva versión.')} />
          )}
        </div>
      )}
      {editing && (
        <ScreenForm screen={editing} onClose={() => setEditing(null)} onSave={(s) => act(async () => {
          const id = await design.save(project, s); setEditing(null); await loadScreens(); setScreenId(id);
        })} />
      )}
    </section>
  );
}

function Versions({ shots, selected, approved, onSelect }: { shots: DesignShot[] | null; selected: number | null; approved: number | null; onSelect: (id: number) => void }) {
  if (shots === null) return <div className="tr-loading"><div className="tr-skel" /></div>;
  if (!shots.length) return <p className="mut" style={{ padding: '4px 12px', fontSize: 12 }}>Sin versiones todavía.</p>;
  return (
    <ul className="tr-list" style={{ padding: 6 }}>
      {shots.map((s, i) => (
        <li key={s.id}><button className="tr-li" aria-selected={s.id === selected} onClick={() => onSelect(s.id)} title={s.note || undefined}>
          <span className={`tr-chip ${s.id === approved ? 'mint' : s.status === 'candidate' ? 'sky' : ''}`}>v{shots.length - i}</span>
          <span className="t">{s.note || STATUS[s.status] || s.status}</span>
          <span className="meta">{s.id === approved ? 'referencia' : STATUS[s.status]}</span>
        </button></li>
      ))}
    </ul>
  );
}

function Capture({ busy, onCapture, onImport }: { busy: boolean; onCapture: (w: number, h: number, note: string) => void; onImport: (f: File, note: string) => void }) {
  const [size, setSize] = useState('1280x800');
  const [note, setNote] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const [w, h] = size.split('x').map(Number);
  return (
    <div className="studio-capture">
      <div className="tr-lab">Nueva versión</div>
      <input className="tr-input" placeholder="Nota (opcional)" value={note} onChange={(e) => setNote(e.currentTarget.value)} aria-label="Nota de la versión" />
      <div className="tr-row">
        <select className="tr-input" value={size} onChange={(e) => setSize(e.currentTarget.value)} aria-label="Tamaño de captura">
          {['1600x1000', '1440x900', '1280x800', '1050x720', '820x600', '390x844'].map((s) => <option key={s} value={s}>{s.replace('x', ' × ')}</option>)}
        </select>
        <button className={`tr-btn sm${busy ? ' busy' : ''}`} disabled={busy} onClick={() => onCapture(w, h, note)}><Icon name="screen" size={13} /> Capturar</button>
      </div>
      <button className="tr-btn sm ghost" disabled={busy} onClick={() => file.current?.click()}><Icon name="attach" size={13} /> Importar PNG…</button>
      <input ref={file} type="file" accept="image/png" hidden onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) onImport(f, note); e.currentTarget.value = ''; }} />
    </div>
  );
}

function Canvas({ shot, image, base, compare, tool, region, onRegion, locks }: {
  shot: DesignShot; image?: string; base?: string; compare: Compare; tool: Tool; region: DesignRegion; onRegion: (r: DesignRegion) => void; locks: Lock[];
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [cam, setCam] = useState({ k: 1, x: 0, y: 0 });
  const [wipe, setWipe] = useState(50);
  const fitted = useRef(false);
  const side = compare === 'lado' && base;
  const fit = useCallback(() => {
    const r = wrap.current?.getBoundingClientRect();
    if (!r) return;
    const totalW = side ? shot.width * 2 + 40 : shot.width;
    const k = Math.min((r.width - 48) / totalW, (r.height - 48) / shot.height, 1.5);
    setCam({ k, x: (r.width - totalW * k) / 2, y: (r.height - shot.height * k) / 2 });
  }, [shot.width, shot.height, side]);
  useEffect(() => { fitted.current = false; fit(); }, [fit, shot.id]);
  useEffect(() => { const ro = new ResizeObserver(() => fit()); if (wrap.current) ro.observe(wrap.current); return () => ro.disconnect(); }, [fit]);

  const toImage = (cx: number, cy: number) => {
    const r = wrap.current!.getBoundingClientRect();
    return { x: ((cx - r.left - cam.x) / cam.k / shot.width) * 100, y: ((cy - r.top - cam.y) / cam.k / shot.height) * 100 };
  };
  const clamp = (n: number) => Math.max(0, Math.min(100, n));
  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.studio-wipe')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const start = { cx: e.clientX, cy: e.clientY, cam, p: toImage(e.clientX, e.clientY) };
    const pan = tool === 'mover' || e.button === 1 || e.altKey;
    const move = (ev: PointerEvent) => {
      if (pan) setCam({ ...start.cam, x: start.cam.x + ev.clientX - start.cx, y: start.cam.y + ev.clientY - start.cy });
      else {
        const p = toImage(ev.clientX, ev.clientY);
        const x0 = clamp(Math.min(start.p.x, p.x)), y0 = clamp(Math.min(start.p.y, p.y));
        onRegion({ x: x0, y: y0, width: Math.max(0.5, clamp(Math.max(start.p.x, p.x)) - x0), height: Math.max(0.5, clamp(Math.max(start.p.y, p.y)) - y0) });
      }
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const onWheel = (e: React.WheelEvent) => {
    const r = wrap.current!.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const k2 = Math.max(0.08, Math.min(4, cam.k * Math.exp(-e.deltaY * 0.01)));
      setCam({ k: k2, x: mx - ((mx - cam.x) * k2) / cam.k, y: my - ((my - cam.y) * k2) / cam.k });
    } else setCam({ ...cam, x: cam.x - e.deltaX, y: cam.y - e.deltaY });
  };
  useEffect(() => {
    const el = wrap.current;
    const stop = (e: WheelEvent) => e.preventDefault();
    el?.addEventListener('wheel', stop, { passive: false });
    return () => el?.removeEventListener('wheel', stop);
  }, []);
  const pct = (r: DesignRegion) => ({ left: `${r.x}%`, top: `${r.y}%`, width: `${r.width}%`, height: `${r.height}%` });
  const frame = (src: string | undefined, label: string, overlay: boolean, extra?: React.ReactNode) => (
    <div className="studio-frame" style={{ width: shot.width, height: shot.height }} aria-label={label}>
      {src ? <img src={src} alt={label} draggable={false} /> : <div className="tr-skel" style={{ position: 'absolute', inset: 0 }} />}
      {extra}
      {overlay && locks.map((l, i) => <div key={i} className="studio-lock" style={pct(l.region)} title={`Bloqueado: ${l.text}`}><span><Icon name="lock" size={11} /> {l.text}</span></div>)}
      {overlay && !(region.width === 100 && region.height === 100) && <div className="studio-region" style={pct(region)} />}
    </div>
  );
  return (
    <div ref={wrap} className={`studio-canvas t-${tool}`} onPointerDown={onDown} onWheel={onWheel} onDoubleClick={fit} tabIndex={0} aria-label="Lienzo"
      onKeyDown={(e) => { if (e.key === '0') fit(); if (e.key === '+' || e.key === '=') setCam((c) => ({ ...c, k: Math.min(4, c.k * 1.2) })); if (e.key === '-') setCam((c) => ({ ...c, k: Math.max(0.08, c.k / 1.2) })); }}>
      <div className="studio-world" style={{ transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.k})` }}>
        {side ? (
          <div style={{ display: 'flex', gap: 40 }}>
            {frame(base, 'Referencia aprobada', false)}
            {frame(image, 'Versión seleccionada', true)}
          </div>
        ) : compare === 'cortinilla' && base ? frame(image, 'Versión seleccionada', true, <>
          <img className="studio-base" src={base} alt="" draggable={false} style={{ clipPath: `inset(0 ${100 - wipe}% 0 0)` }} />
          <div className="studio-wipe" style={{ left: `${wipe}%` }} onPointerDown={(e) => {
            e.stopPropagation();
            const r = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
            const move = (ev: PointerEvent) => setWipe(Math.max(0, Math.min(100, ((ev.clientX - r.left) / r.width) * 100)));
            const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
            window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
          }} role="slider" aria-label="Cortinilla" aria-valuenow={Math.round(wipe)} tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'ArrowLeft') setWipe((w) => Math.max(0, w - 5)); if (e.key === 'ArrowRight') setWipe((w) => Math.min(100, w + 5)); }} />
        </>) : compare === 'diferencia' && base ? frame(image, 'Diferencia con la referencia', true, <img className="studio-base studio-diff" src={base} alt="" draggable={false} />)
          : frame(image, 'Versión seleccionada', true)}
      </div>
      {compare !== 'una' && !base && <div className="studio-hint">No hay referencia aprobada distinta de esta versión para comparar.</div>}
      <div className="tr-zoom">
        <button className="tr-btn sm icon ghost" onClick={() => setCam((c) => ({ ...c, k: Math.min(4, c.k * 1.2) }))} aria-label="Acercar"><Icon name="zin" size={14} /></button>
        <button className="tr-btn sm icon ghost" onClick={() => setCam((c) => ({ ...c, k: Math.max(0.08, c.k / 1.2) }))} aria-label="Alejar"><Icon name="zout" size={14} /></button>
        <button className="tr-btn sm icon ghost" onClick={fit} aria-label="Encajar"><Icon name="fit" size={14} /></button>
      </div>
    </div>
  );
}

function Inspector({ project, screen, shot, baseline, region, parsed, busy, agentSessions, onOpenSession, onSaveConstraints, onRegion, onReview, onSend }: {
  project: string; screen: DesignScreen; shot: DesignShot | null; baseline: DesignShot | null; region: DesignRegion; parsed: { locks: Lock[]; rest: string }; busy: boolean;
  agentSessions: Session[]; onOpenSession: (id: number) => void; onSaveConstraints: (locks: Lock[], rest: string) => void; onRegion: (r: DesignRegion) => void;
  onReview: (approve: boolean, confirmed: boolean) => void; onSend: (session: number, request: string, compare: boolean) => void;
}) {
  const designers = agentSessions.filter((s) => s.project === project && s.engine === 'claude' && s.worktree);
  const [session, setSession] = useState<number | null>(designers[0]?.id ?? null);
  const [models, setModels] = useState<{ id: string; label: string }[]>([]);
  const [model, setModel] = useState<string | null>(null);
  const [request, setRequest] = useState('');
  const [cmp, setCmp] = useState(false);
  const [sendOk, setSendOk] = useState(false);
  const [reviewOk, setReviewOk] = useState(false);
  const [lockText, setLockText] = useState('');
  const [rest, setRest] = useState(parsed.rest);
  useEffect(() => setRest(parsed.rest), [parsed.rest]);
  useEffect(() => { if (session == null && designers[0]) setSession(designers[0].id); }, [designers, session]);
  useEffect(() => {
    if (session == null) return;
    sessionApi.claudeOptions(session).then((o) => { setModels(o.models); setModel(o.pinnedModel); }, () => setModels([]));
  }, [session]);
  useEffect(() => { setReviewOk(false); setSendOk(false); }, [shot?.id]);
  const full = region.width === 100 && region.height === 100;
  const canReview = shot?.status === 'candidate';
  return (
    <aside className="tr-insp" aria-label="Encargo y revisión">
      <div className="sec">
        <div className="tr-lab">Encargo a Claude</div>
        {designers.length === 0 ? (
          <div className="tr-note"><Icon name="info" size={14} /><span>Para encargar cambios hace falta una sesión Claude abierta en un worktree de este proyecto. Créala desde el Workspace con aislamiento.</span></div>
        ) : (
          <div className="tr-col">
            <label className="tr-field-row">Sesión
              <select value={session ?? ''} onChange={(e) => setSession(Number(e.currentTarget.value))}>
                {designers.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.branch ?? 'worktree'}</option>)}
              </select>
            </label>
            {models.length > 0 && (
              <label className="tr-field-row">Modelo de la sesión
                <select value={model ?? ''} onChange={(e) => { const v = e.currentTarget.value; sessionApi.setOption(session!, 'model', v).then(() => setModel(v || null)); }}>
                  <option value="">Predeterminado</option>
                  {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              </label>
            )}
            <div className="mut" style={{ fontSize: 12 }}>{full ? 'Región: toda la pantalla. Dibuja en el lienzo para acotar.' : `Región: ${Math.round(region.x)}, ${Math.round(region.y)} · ${Math.round(region.width)} × ${Math.round(region.height)} %`}</div>
            <textarea rows={4} placeholder={cmp ? 'Qué quieres que compare' : 'Qué debe cambiar en esta región'} value={request} onChange={(e) => setRequest(e.currentTarget.value)} aria-label="Encargo" />
            <label className="tr-row" style={{ fontSize: 12 }}><input type="checkbox" checked={cmp} disabled={!baseline || baseline.id === shot?.id} onChange={(e) => setCmp(e.currentTarget.checked)} /> Solo comparar con la referencia (no edita archivos)</label>
            <label className="tr-row" style={{ fontSize: 12 }}><input type="checkbox" checked={sendOk} onChange={(e) => setSendOk(e.currentTarget.checked)} /> Enviar la captura y las restricciones a la sesión</label>
            <div className="tr-row">
              <button className={`tr-btn pearl sm${busy ? ' busy' : ''}`} disabled={busy || !shot || !sendOk || !request.trim() || session == null} onClick={() => { onSend(session!, request, cmp); setRequest(''); setSendOk(false); }}><Icon name="send" size={13} /> Enviar</button>
              {session != null && <button className="tr-btn sm ghost" onClick={() => onOpenSession(session)}>Ver conversación</button>}
            </div>
          </div>
        )}
      </div>
      <div className="sec">
        <div className="tr-lab">Bloqueos</div>
        {parsed.locks.length === 0 ? <p className="mut" style={{ margin: '0 0 8px', fontSize: 12 }}>Nada bloqueado. Marca una región y bloquéala para que ningún encargo la cambie.</p> : (
          <ul className="tr-list" style={{ marginBottom: 8 }}>
            {parsed.locks.map((l, i) => (
              <li key={i} className="tr-row">
                <button className="tr-li" onClick={() => onRegion(l.region)} title="Seleccionar región"><Icon name="lock" size={12} /><span className="t">{l.text || 'sin descripción'}</span></button>
                <button className="tr-btn sm icon ghost" aria-label="Quitar bloqueo" disabled={busy} onClick={() => onSaveConstraints(parsed.locks.filter((_, j) => j !== i), parsed.rest)}><Icon name="unlock" size={13} /></button>
              </li>
            ))}
          </ul>
        )}
        <div className="tr-row">
          <input className="tr-input" style={{ flex: 1 }} placeholder="Qué se bloquea (p. ej. cabecera)" value={lockText} onChange={(e) => setLockText(e.currentTarget.value)} aria-label="Descripción del bloqueo" />
          <button className="tr-btn sm" disabled={busy || full || !lockText.trim()} title={full ? 'Marca antes una región' : undefined}
            onClick={() => { onSaveConstraints([...parsed.locks, { region, text: lockText }], parsed.rest); setLockText(''); }}><Icon name="lock" size={13} /> Bloquear</button>
        </div>
        <label className="tr-field-row" style={{ marginTop: 10 }}>Restricciones generales
          <textarea rows={3} value={rest} onChange={(e) => setRest(e.currentTarget.value)} />
        </label>
        <button className="tr-btn sm" style={{ marginTop: 6 }} disabled={busy || rest === parsed.rest} onClick={() => onSaveConstraints(parsed.locks, rest)}>Guardar restricciones</button>
      </div>
      <div className="sec">
        <div className="tr-lab">Revisión</div>
        {!shot ? <p className="mut" style={{ margin: 0 }}>Sin versión seleccionada.</p> : !canReview ? (
          <p className="mut" style={{ margin: 0, fontSize: 12 }}>Esta versión está {STATUS[shot.status] ?? shot.status}. Solo las candidatas se aprueban o descartan.</p>
        ) : (
          <div className="tr-col">
            <label className="tr-row" style={{ fontSize: 12 }}><input type="checkbox" checked={reviewOk} onChange={(e) => setReviewOk(e.currentTarget.checked)} /> He revisado la captura{baseline ? ', la referencia' : ''} y las restricciones</label>
            <div className="tr-row">
              <button className="tr-btn sm pearl" disabled={busy || !reviewOk} onClick={() => onReview(true, true)}><Icon name="check" size={13} /> {baseline ? 'Aprobar versión' : 'Aprobar como referencia'}</button>
              <button className="tr-btn sm danger" disabled={busy} onClick={() => onReview(false, false)}>Descartar</button>
            </div>
          </div>
        )}
      </div>
      <div className="sec">
        <dl className="tr-kv">
          <dt>URL</dt><dd className="mono">{screen.url}</dd>
          <dt>Revisión</dt><dd>{screen.revision ?? '—'}</dd>
          {shot && <><dt>Tamaño</dt><dd className="mono">{shot.width} × {shot.height}</dd><dt>Origen</dt><dd>{shot.source}</dd></>}
        </dl>
      </div>
    </aside>
  );
}

function ScreenForm({ screen, onClose, onSave }: { screen: DesignScreen; onClose: () => void; onSave: (s: DesignScreen) => void }) {
  const [form, setForm] = useState(screen);
  return (
    <Modal title={screen.id == null ? 'Nueva pantalla' : 'Editar pantalla'} onClose={onClose}>
      <div className="tr-col">
        <label className="tr-field-row">Nombre<input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} /></label>
        <label className="tr-field-row">URL<input value={form.url} placeholder="http://localhost:5173/" onChange={(e) => setForm({ ...form, url: e.currentTarget.value })} /></label>
      </div>
      <div className="acts">
        <button className="tr-btn ghost" onClick={onClose}>Cancelar</button>
        <button className="tr-btn pearl" disabled={!form.name.trim() || !form.url.trim()} onClick={() => onSave(form)}>Guardar</button>
      </div>
    </Modal>
  );
}
