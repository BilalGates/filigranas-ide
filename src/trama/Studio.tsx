import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { design, sessions as sessionApi, type DesignComponent, type DesignRegion, type DesignScreen, type DesignShot, type Session } from '../ipc';
import { joinConstraints, parseConstraints, type Lock } from './constraints';
import { Icon } from './icons';
import { EmptyArt, Root } from './kit';
import { Modal } from './ui';
import StudioReferences from './StudioReferences';

// Studio de Trama v2 sobre el bucle de diseño existente: pantallas y
// versiones (capturas reales), lienzo con regiones y comparación, bloqueos
// guardados en las restricciones (el núcleo los envía con cada encargo),
// revisión y encargo a una sesión Claude del proyecto. Enviar no simula
// cambios: la versión nueva aparece al capturar de nuevo.
type Tool = 'select' | 'region' | 'hand';
type Cmp = null | 'split' | 'side' | 'diff';
const FULL: DesignRegion = { x: 0, y: 0, width: 100, height: 100 };
const SIZES: [number, number][] = [[1600, 1000], [1440, 900], [1280, 800], [1050, 720], [820, 600], [390, 844]];
const ST: Record<string, string> = { candidate: 'candidata', approved: 'aprobada', discarded: 'descartada' };
const fileBase64 = (file: File) => new Promise<string>((ok, ko) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] ?? ''); r.onerror = () => ko(r.error); r.readAsDataURL(file); });
const validSize = (size: [number, number]) => size.every((n) => Number.isInteger(n) && n >= 64 && n <= 4096);
const validRegion = (r: DesignRegion) => r.x >= 0 && r.y >= 0 && r.width >= 1 && r.height >= 1 && r.x + r.width <= 100 && r.y + r.height <= 100;
const sendRegion = (r: DesignRegion) => {
  const x = Math.min(99, Math.floor(r.x)), y = Math.min(99, Math.floor(r.y));
  return { x, y, width: Math.min(100 - x, Math.ceil(r.x + r.width) - x), height: Math.min(100 - y, Math.ceil(r.y + r.height) - y) };
};
const isFull = (r: DesignRegion) => r.width >= 99.9 && r.height >= 99.9;
const componentRegion = (component: DesignComponent, shot: DesignShot): DesignRegion => ({
  x: component.x * 100 / shot.width, y: component.y * 100 / shot.height,
  width: component.width * 100 / shot.width, height: component.height * 100 / shot.height,
});

export default function Studio({ project, projectName, agentSessions, view, onView, canvas, onNewSession, onOpenSession, onBrowser }: {
  project: string | null; projectName: string | null; agentSessions: Session[]; view: 'captures' | 'canvas'; onView: (view: 'captures' | 'canvas') => void; canvas: React.ReactNode; onNewSession: () => void; onOpenSession: (id: number) => void; onBrowser: () => void;
}) {
  const [screens, setScreens] = useState<DesignScreen[] | null>(null);
  const [screenId, setScreenId] = useState<number | null>(null);
  const [shots, setShots] = useState<DesignShot[] | null>(null);
  const [shotId, setShotId] = useState<number | null>(null);
  const [componentMaps, setComponentMaps] = useState<Record<number, DesignComponent[]>>({});
  const [selector, setSelector] = useState<string | null>(null);
  const [referenceIds, setReferenceIds] = useState<number[]>([]);
  const imageRequests = useRef(new Set<number>());
  const [images, setImages] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [region, setRegion] = useState<DesignRegion>(FULL);
  const [tool, setTool] = useState<Tool>('region');
  const [compareId, setCompareId] = useState<number | null>(null);
  const shotsRequest = useRef(0);
  const [cmp, setCmp] = useState<Cmp>(null);
  const [size, setSize] = useState<[number, number]>([1440, 900]);
  const [editing, setEditing] = useState<DesignScreen | null>(null);
  const [sent, setSent] = useState<{ text: string; label: string; at: number }[]>([]);
  const [inspOpen, setInspOpen] = useState(false);
  const [leftOpen, setLeftOpen] = useState(false);
  const screen = screens?.find((s) => s.id === screenId) ?? null;
  const shot = shots?.find((s) => s.id === shotId) ?? null;
  const baseline = screen?.approved != null ? shots?.find((s) => s.id === screen.approved) ?? null : null;
  const reference = (compareId == null ? baseline : shots?.find((item) => item.id === compareId)) ?? null;
  const comparable = !!shot && !!reference && reference.id !== shot.id && reference.width === shot.width && reference.height === shot.height;
  const reviewable = !baseline || (!!shot && baseline.width === shot.width && baseline.height === shot.height);
  const parsed = useMemo(() => parseConstraints(screen?.constraints ?? ''), [screen?.constraints]);
  const components = shotId == null ? undefined : componentMaps[shotId];
  const selected = components?.find((item) => item.selector === selector) ?? null;
  const visibleLocks = parsed.locks.map((lock) => {
    const item = lock.selector && components?.find((item) => item.selector === lock.selector);
    return item && shot ? { ...lock, region: componentRegion(item, shot) } : lock;
  });
  const chooseComponent = (component: DesignComponent | null) => {
    setSelector(component?.selector ?? null);
    setRegion(component && shot ? componentRegion(component, shot) : FULL);
  };
  const changeRegion = (next: DesignRegion) => { setSelector(null); setRegion(next); };

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
    const request = ++shotsRequest.current;
    const list = await design.shots(project, id);
    if (request !== shotsRequest.current) return;
    setShots(list);
    setShotId((cur) => list.some((s) => s.id === cur) ? cur : list.find((s) => s.status === 'candidate')?.id ?? list[0]?.id ?? null);
  }, [project]);
  useEffect(() => { setScreens(null); setScreenId(null); setShots(null); setImages({}); void loadScreens(); }, [loadScreens]);
  useEffect(() => { if (screenId != null) loadShots(screenId).catch((e) => setError(String(e))); else setShots(null); }, [screenId, loadShots]);
  useEffect(() => {
    if (!project || screenId == null || !shots) return;
    const visible = [...new Set([...shots.slice(0, 12), ...[shot, reference].filter((item) => item != null)])];
    for (const s of visible) {
      if (images[s.id] || imageRequests.current.has(s.id)) continue;
      imageRequests.current.add(s.id);
      design.image(project, screenId, s.id).then((b) => setImages((m) => ({ ...m, [s.id]: `data:image/png;base64,${b}` })), (error) => setError(String(error)));

    }
  }, [project, screenId, shots, images, shot, reference]);
  useEffect(() => {
    if (!project || screenId == null || shotId == null) return;
    let active = true;
    design.components(project, screenId, shotId).then(
      (items) => { if (active) setComponentMaps((previous) => ({ ...previous, [shotId]: items })); },
      (error) => { if (active) setError(String(error)); },
    );
    return () => { active = false; };
  }, [project, screenId, shotId]);
  useEffect(() => { setReferenceIds([]); }, [screenId]);
  useEffect(() => { setSelector(null); setRegion(FULL); }, [shotId]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (view !== 'captures' || (e.target as HTMLElement).closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey) return;
      if (e.key === 'v' || e.key === 'V') setTool('select');
      else if (e.key === 'r' || e.key === 'R') setTool('region');
      else if (e.key === 'h' || e.key === 'H') setTool('hand');
      else if (comparable && (e.key === 'c' || e.key === 'C')) setCmp((c) => c ? null : 'split');
      else if (e.key === 'Escape') { setSelector(null); setRegion(FULL); }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [view, comparable]);
  const saveConstraints = (locks: Lock[], rest: string) => act(async () => {
    if (!project || !screen) return;
    await design.save(project, { ...screen, constraints: joinConstraints(locks, rest) });
    await loadScreens();
  }, 'Protecciones guardadas. Se envían con cada encargo de esta pantalla.');

  if (!project) return <Root label="Studio"><div className="studio-empty"><div className="empty big"><EmptyArt /><h3>Elige un proyecto</h3><p>Studio trabaja sobre las pantallas de diseño del proyecto abierto.</p></div></div></Root>;
  const newScreen = () => setEditing({ id: null, name: '', url: '', constraints: '', revision: null, approved: null });
  return (
    <Root label="Studio">
      <div className="studio-views" role="group" aria-label="Vista de Studio">
        <button className="btn sm" aria-pressed={view === 'captures'} onClick={() => onView('captures')}>Pantallas y versiones</button>
        <button className="btn sm" aria-pressed={view === 'canvas'} onClick={() => onView('canvas')}>Diseñar barra lateral</button>
      </div>
      {view === 'canvas' ? <section className="studio-sidebar-design" aria-label="Diseño de barra lateral">{canvas}</section> :
      <div className={`studio${inspOpen ? ' insp-open' : ''}${leftOpen ? ' left-open' : ''}`}>
        <aside className="slist" aria-label="Pantallas y versiones">
          <div className="ph"><h3 className="grow">Pantallas</h3><button className="tbtn" onClick={newScreen} aria-label="Nueva pantalla" title="Nueva pantalla"><Icon name="plus" size={14} /></button></div>
          {(screens ?? []).map((s) => (
            <button key={s.id} className={`scrn${s.id === screenId ? ' on' : ''}`} onClick={() => { if (s.id === screenId) return; ++shotsRequest.current; setShots(null); setShotId(null); setScreenId(s.id); setRegion(FULL); setCompareId(null); setCmp(null); }}>
              <Icon name="screen" size={14} /><span className="grow">{s.name}</span>{s.approved != null && <span className="chip tiny mint">aprobada</span>}
            </button>
          ))}
          {screens && !screens.length && <p className="mut2" style={{ padding: '6px 12px' }}>Sin pantallas todavía.</p>}
          {screen && <>
            <div className="tgroup" style={{ marginTop: 10, display: 'flex', alignItems: 'center' }}><span className="grow">Versiones · {screen.name}</span><button className="tbtn" onClick={() => setEditing(screen)} aria-label="Editar pantalla" title="Editar pantalla"><Icon name="edit" size={12} /></button></div>
            <div className="vers">
              {shots === null ? <div className="tr-skel" style={{ height: 36 }} /> : shots.map((x, i) => (
                <button key={x.id} className={`ver${x.id === shotId && !cmp ? ' on' : ''} st-${ST[x.status] ?? x.status}`} onClick={() => { setShotId(x.id); setCompareId(null); setCmp(null); }}>
                  <span className="th">{images[x.id] ? <img src={images[x.id]} alt="" /> : null}</span>
                  <span className="vt2"><span className="v1">v{shots.length - i} <span className={`chip tiny ${x.id === screen.approved ? 'mint' : x.status === 'candidate' ? 'sky' : ''}`}>{x.id === screen.approved ? 'aprobada' : ST[x.status] ?? x.status}</span></span><span className="v2">{x.source}{x.note ? ` · ${x.note}` : ''}</span></span>
                </button>
              ))}
              {shots && !shots.length && <p className="mut2" style={{ margin: 0 }}>{screen.url ? 'Captura la URL o importa un PNG para crear la primera versión.' : 'Importa un PNG para crear la primera versión.'}</p>}
            </div>
            <p className="sample" style={{ padding: '0 12px 12px' }}>{screen.url ? <>Cada versión es una captura real de {screen.url} o una imagen importada.</> : 'Cada versión es una imagen importada.'}</p>
          </>}
        </aside>
        <section className={`canvasw tool-${tool}`} aria-label="Lienzo">
          <div className="cwhead">
            <button className="tbtn narrow-only" onClick={() => setLeftOpen(!leftOpen)} aria-label="Pantallas"><Icon name="sidebar" size={16} /></button>
            <span className="lab">{cmp ? 'Comparación' : screen?.name ?? projectName}</span>
            <span className="grow" />
            <div className="seg" role="group" aria-label="Tamaño de captura">
              {SIZES.slice(0, 4).map(([w, h]) => <button key={w} className={size[0] === w ? 'on' : ''} aria-pressed={size[0] === w} onClick={() => setSize([w, h])}>{w}</button>)}
            </div>
            {screen?.url && <button className="btn sm ghost" onClick={() => act(async () => { await design.preview(project, screen.id!); onBrowser(); })} title="Abrir en el navegador integrado"><Icon name="globe" size={12} /> Vista previa</button>}
            <button className="tbtn narrow-only" onClick={() => setInspOpen(!inspOpen)} aria-label="Inspector"><Icon name="panel" size={16} /></button>
          </div>
          {!screens ? <div className="flow-loading"><span className="spin" /></div>
            : !screen ? (
              <div className="studio-empty"><div className="empty big"><EmptyArt /><h3>{projectName} no tiene pantallas de diseño</h3>
                <p>Una pantalla es una URL de tu proyecto. Captúrala, marca regiones, protege lo que no debe cambiar y encarga cambios a una sesión Claude del proyecto.</p>
                <div className="row"><button className="btn pearl" onClick={newScreen}><Icon name="plus" size={13} /> Crear la primera pantalla</button></div></div></div>
            ) : !shot ? (
              <div className="studio-empty"><div className="empty big"><EmptyArt /><h3>Sin capturas de {screen.name}</h3><p>{screen.url ? `Captura ${screen.url} a ${size[0]} × ${size[1]} o importa una imagen.` : 'Importa una imagen para crear la primera versión.'}</p>
                <div className="row"><CaptureButtons busy={busy} hasUrl={!!screen.url} size={size} onCapture={(note) => act(async () => { const id = await design.capture(project, screen.id!, size[0], size[1], note); await loadShots(screen.id!); setShotId(id); }, 'Captura guardada como candidata.')}
                  onImport={(f, note) => act(async () => { const id = await design.import(project, screen.id!, await fileBase64(f), note); await loadShots(screen.id!); setShotId(id); }, 'Imagen importada como candidata.')} /></div></div></div>
            ) : (
              <Canvas key={shot.id} shot={shot} image={images[shot.id]} base={comparable && reference ? images[reference.id] : undefined} cmp={comparable ? cmp : null} tool={tool} region={region} onRegion={changeRegion} locks={visibleLocks} components={components ?? []} selected={selected} onSelect={chooseComponent} />
            )}
          {shot && (
            <div className="toolbar" role="toolbar" aria-label="Herramientas">
              {([['select', 'cursor', 'Seleccionar', 'V'], ['region', 'region', 'Región', 'R'], ['hand', 'hand', 'Mover lienzo', 'H']] as [Tool, string, string, string][]).map(([id, ic, l, k]) => (
                <button key={id} className={tool === id ? 'on' : ''} aria-pressed={tool === id} onClick={() => setTool(id)} title={`${l} (${k})`} aria-label={l}><Icon name={ic} size={17} /></button>
              ))}
              <span className="sep" />
              <button disabled={isFull(region) || !validRegion(region) || busy || !!selected} onClick={() => saveConstraints([...parsed.locks, { region, text: `Región ${Math.round(region.x)},${Math.round(region.y)}` }], parsed.rest)} title="Proteger la región marcada" aria-label="Proteger región"><Icon name="lock" size={17} /></button>
              <button className={cmp ? 'on' : ''} aria-pressed={!!cmp} disabled={!comparable} onClick={() => setCmp(cmp ? null : 'split')} title={comparable ? 'Comparar con la versión elegida (C)' : 'Elige otra versión del mismo tamaño'} aria-label="Comparar"><Icon name="compare" size={17} /></button>
            </div>
          )}
          {shot && screen && <div className="studio-version-compare">
            <label className="fsel">Comparar con<select value={compareId ?? ''} onChange={(e) => { setCompareId(e.target.value ? Number(e.target.value) : null); setCmp('split'); }} aria-label="Comparar con versión">
              <option value="">Referencia aprobada</option>
              {(shots ?? []).filter((item) => item.id !== shot.id && item.width === shot.width && item.height === shot.height).map((item) => <option key={item.id} value={item.id}>#{item.id} · {item.note || ST[item.status]}</option>)}
            </select></label>
          </div>}
          {shot && screen && (
            <StudioComposer project={project} screen={screen} shot={shot} baseline={baseline} region={region} cmp={comparable ? cmp : null} busy={busy} reviewable={reviewable} onNewSession={onNewSession} agentSessions={agentSessions} locks={visibleLocks} selected={selected} references={referenceIds.length}
              onCmp={setCmp} onClear={() => chooseComponent(null)} onOpenSession={onOpenSession}
              onReview={(approve) => act(async () => { await design.review(project, screen.id!, { shot: shot.id, baseline: screen.approved, revision: screen.revision ?? 0, approve, confirmed: approve }); await loadScreens(); await loadShots(screen.id!); setCmp(null); }, approve ? 'Versión aprobada como referencia.' : 'Versión descartada.')}
              onSend={(session, text, compare) => act(async () => { await design.send(project, { session, screen: screen.id!, shot: shot.id, region: sendRegion(region), request: text, compare, confirmed: true, references: referenceIds, component: selected?.selector ?? null }); setSent((l) => [{ text, label: selected?.name ?? (isFull(region) ? 'Toda la pantalla' : `Región ${Math.round(region.x)},${Math.round(region.y)} · ${Math.round(region.width)}×${Math.round(region.height)} %`), at: Date.now() }, ...l]); },
                compare ? 'Comparación enviada; la respuesta llegará a la conversación de la sesión.' : 'Encargo enviado. Captura de nuevo cuando la sesión termine para ver la nueva versión.')} />
          )}
          {(error || notice) && <div className={`studio-toast${error ? ' err' : ''}`} role="status">{error ?? notice}<button className="tbtn" onClick={() => { setError(null); setNotice(null); }} aria-label="Cerrar"><Icon name="close" size={12} /></button></div>}
        </section>
        <aside className="insp" aria-label="Inspector de diseño">
          {screen ? (
            <StudioInsp key={screen.id} screen={screen} shot={shot} region={region} parsed={parsed} busy={busy} sent={sent} size={size} onSize={setSize}
              candidateImage={shot ? images[shot.id] : undefined} referenceImage={comparable && reference ? images[reference.id] : undefined}
              components={components} selected={selected} onSelect={chooseComponent} onRegion={changeRegion} onSave={saveConstraints}
              references={<StudioReferences key={screen.id} project={project} screen={screen.id!} included={referenceIds} onIncluded={setReferenceIds} />}
              onCapture={(note) => act(async () => { const id = await design.capture(project, screen.id!, size[0], size[1], note); await loadShots(screen.id!); setShotId(id); }, 'Captura guardada como candidata.')}
              onImport={(f, note) => act(async () => { const id = await design.import(project, screen.id!, await fileBase64(f), note); await loadShots(screen.id!); setShotId(id); }, 'Imagen importada como candidata.')} />
          ) : <div className="sec"><h3>Studio</h3><p className="mut2">Crea una pantalla para empezar a iterar su diseño con capturas reales.</p></div>}
        </aside>
      </div>}
      {editing && <ScreenForm screen={editing} onClose={() => setEditing(null)} onSave={(s) => act(async () => { const id = await design.save(project, s); setEditing(null); await loadScreens(); setScreenId(id); })} />}
    </Root>
  );
}

function CaptureButtons({ busy, hasUrl, size, onCapture, onImport }: { busy: boolean; hasUrl: boolean; size: [number, number]; onCapture: (note: string) => void; onImport: (f: File, note: string) => void }) {
  const file = useRef<HTMLInputElement>(null);
  return <>
    {hasUrl && <button className={`btn pearl${busy ? ' busy' : ''}`} disabled={busy || !validSize(size)} onClick={() => onCapture('')}><Icon name="screen" size={13} /> Capturar a {size[0]} × {size[1]}</button>}
    <button className="btn" disabled={busy} onClick={() => file.current?.click()}><Icon name="attach" size={13} /> Importar PNG…</button>
    <input ref={file} type="file" accept="image/png" hidden onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) onImport(f, ''); e.currentTarget.value = ''; }} />
  </>;
}

function Canvas({ shot, image, base, cmp, tool, region, onRegion, locks, components, selected, onSelect }: { shot: DesignShot; image?: string; base?: string; cmp: Cmp; tool: Tool; region: DesignRegion; onRegion: (r: DesignRegion) => void; locks: Lock[]; components: DesignComponent[]; selected: DesignComponent | null; onSelect: (c: DesignComponent | null) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [cam, setCam] = useState({ k: 1, x: 0, y: 0 });
  const [cut, setCut] = useState(50);
  const [hover, setHover] = useState<DesignComponent | null>(null);
  const side = cmp === 'side' && base;
  const fit = useCallback(() => {
    const r = wrap.current?.getBoundingClientRect();
    if (!r) return;
    const totalW = side ? shot.width * 2 + 80 : shot.width;
    const k = Math.max(0.08, Math.min((r.width - 80) / totalW, (r.height - 210) / shot.height, 1.2));
    setCam({ k, x: (r.width - totalW * k) / 2 - 20, y: Math.max(56, (r.height - shot.height * k) / 2 - 40) });
  }, [shot.width, shot.height, side]);
  useEffect(() => { fit(); }, [fit, shot.id]);
  useEffect(() => { const ro = new ResizeObserver(() => fit()); if (wrap.current) ro.observe(wrap.current); return () => ro.disconnect(); }, [fit]);
  useEffect(() => { const el = wrap.current; const stop = (e: WheelEvent) => e.preventDefault(); el?.addEventListener('wheel', stop, { passive: false }); return () => el?.removeEventListener('wheel', stop); }, []);
  const toImg = (cx: number, cy: number) => { const r = wrap.current!.getBoundingClientRect(); return { x: ((cx - r.left - cam.x) / cam.k / shot.width) * 100, y: ((cy - r.top - cam.y) / cam.k / shot.height) * 100 }; };
  const hit = (cx: number, cy: number) => {
    const point = toImg(cx, cy);
    const x = point.x * shot.width / 100, y = point.y * shot.height / 100;
    let best: DesignComponent | null = null;
    for (const item of components) {
      if (x < item.x || y < item.y || x > item.x + item.width || y > item.y + item.height) continue;
      if (!best || item.width * item.height <= best.width * best.height) best = item;
    }
    return best;
  };
  const clamp = (n: number) => Math.max(0, Math.min(100, n));
  const pct = (r: DesignRegion) => ({ left: `${r.x}%`, top: `${r.y}%`, width: `${r.width}%`, height: `${r.height}%` });
  const frame = (src: string | undefined, label: string, overlay: boolean, extra?: React.ReactNode) => (
    <div className="artboard-real" style={{ width: shot.width, height: shot.height }}>
      <div className="frameLabel">{label}</div>
      <div className="frame">{src ? <img src={src} alt={label} draggable={false} /> : <div className="tr-skel" style={{ position: 'absolute', inset: 0 }} />}{extra}
        {overlay && locks.map((l, i) => <div key={i} className="lockbox" style={pct(l.region)}><span><Icon name="lock" size={11} /> {l.text}</span></div>)}
        {overlay && !selected && !isFull(region) && <div className="regbox" style={pct(region)} />}
        {overlay && !cmp && selected && <div className="studio-component-box selected" style={pct(componentRegion(selected, shot))}><span>{selected.name}</span></div>}
        {overlay && !cmp && tool === 'select' && hover && hover.selector !== selected?.selector && <div className="studio-component-box" style={pct(componentRegion(hover, shot))}><span>{hover.name}</span></div>}
      </div>
    </div>
  );
  return (
    <div ref={wrap} className="studio-stage" tabIndex={0} aria-label="Lienzo"
      onPointerMove={(e) => { if (tool === 'select' && !cmp && !e.buttons) setHover(hit(e.clientX, e.clientY)); }}
      onPointerLeave={() => setHover(null)}
      onPointerDown={(e) => {
        if (e.button > 1 || (e.target as HTMLElement).closest('.cmpbar, .studio-zoomtools')) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const start = { cx: e.clientX, cy: e.clientY, cam, p: toImg(e.clientX, e.clientY) };
        const pan = tool !== 'region' || e.button === 1 || e.altKey;
        const move = (ev: PointerEvent) => {
          if (pan) setCam({ ...start.cam, x: start.cam.x + ev.clientX - start.cx, y: start.cam.y + ev.clientY - start.cy });
          else { const p = toImg(ev.clientX, ev.clientY), x0 = clamp(Math.min(start.p.x, p.x)), y0 = clamp(Math.min(start.p.y, p.y)); onRegion({ x: x0, y: y0, width: Math.max(0.5, clamp(Math.max(start.p.x, p.x)) - x0), height: Math.max(0.5, clamp(Math.max(start.p.y, p.y)) - y0) }); }
        };
        const up = (ev: PointerEvent) => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
          if (ev.type === 'pointerup' && tool === 'select' && !cmp && e.button === 0 && !e.altKey &&
              Math.hypot(ev.clientX - start.cx, ev.clientY - start.cy) < 4) {
            onSelect(hit(ev.clientX, ev.clientY));
          }
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
      }}
      onWheel={(e) => {
        const r = wrap.current!.getBoundingClientRect();
        if (e.ctrlKey || e.metaKey) { const mx = e.clientX - r.left, my = e.clientY - r.top, k2 = Math.max(0.08, Math.min(4, cam.k * Math.exp(-e.deltaY * 0.01))); setCam({ k: k2, x: mx - ((mx - cam.x) * k2) / cam.k, y: my - ((my - cam.y) * k2) / cam.k }); }
        else setCam({ ...cam, x: cam.x - e.deltaX, y: cam.y - e.deltaY });
      }}
      onDoubleClick={fit}
      onKeyDown={(e) => { if (e.key === '0') fit(); if (e.key === '+' || e.key === '=') setCam((c) => ({ ...c, k: Math.min(4, c.k * 1.2) })); if (e.key === '-') setCam((c) => ({ ...c, k: Math.max(0.08, c.k / 1.2) })); }}>
      <div className="world" style={{ transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.k})` }}>
        {side ? <div style={{ display: 'flex', gap: 80 }}>{frame(base, 'Referencia aprobada', false)}{frame(image, 'Versión seleccionada', true)}</div>
          : cmp === 'split' && base ? frame(image, 'Antes (referencia) · después (versión)', true, <>
            <img className="cmpA-img" src={base} alt="" draggable={false} style={{ clipPath: `inset(0 ${100 - cut}% 0 0)` }} />
            <div className="cmpbar real" style={{ left: `${cut}%` }} role="slider" tabIndex={0} aria-label="Divisor antes y después" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(cut)}
              onPointerDown={(e) => { e.stopPropagation(); const r = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect(); const move = (ev: PointerEvent) => setCut(Math.max(0, Math.min(100, ((ev.clientX - r.left) / r.width) * 100))); const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); }; window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); }}
              onKeyDown={(e) => { if (e.key === 'ArrowLeft') setCut((v) => Math.max(0, v - 5)); if (e.key === 'ArrowRight') setCut((v) => Math.min(100, v + 5)); }} />
          </>)
          : cmp === 'diff' && base ? frame(image, 'Diferencias con la referencia', true, <img className="diff-img" src={base} alt="" draggable={false} />)
          : frame(image, `${shot.width} × ${shot.height} · ${shot.source}`, true)}
      </div>
      <div className="studio-zoomtools">
        <span className="zoomv" title="Escala respecto al tamaño real">{Math.round(cam.k * 100)}%</span>
        <button className="tbtn" onClick={() => setCam((c) => ({ ...c, k: Math.max(0.08, c.k / 1.2) }))} aria-label="Alejar"><Icon name="zout" size={15} /></button>
        <button className="tbtn" onClick={fit} aria-label="Ajustar"><Icon name="fit" size={15} /></button>
        <button className="tbtn" onClick={() => setCam((c) => ({ ...c, k: Math.min(4, c.k * 1.2) }))} aria-label="Acercar"><Icon name="zin" size={15} /></button>
      </div>
    </div>
  );
}

function StudioComposer({ project, shot, baseline, region, cmp, busy, agentSessions, locks, selected, references, onCmp, onClear, onOpenSession, onNewSession, reviewable, onReview, onSend }: {
  project: string; screen: DesignScreen; shot: DesignShot; baseline: DesignShot | null; region: DesignRegion; cmp: Cmp; busy: boolean; agentSessions: Session[]; locks: Lock[]; selected: DesignComponent | null; references: number;
  onNewSession: () => void; reviewable: boolean; onCmp: (c: Cmp) => void; onClear: () => void; onOpenSession: (id: number) => void; onReview: (approve: boolean) => void; onSend: (session: number, text: string, compare: boolean) => void;
}) {
  const designers = agentSessions.filter((s) => s.project === project && s.engine === 'claude');
  const [session, setSession] = useState<number | null>(designers[0]?.id ?? null);
  const [models, setModels] = useState<{ id: string; label: string }[]>([]);
  const [model, setModel] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [approve, setApprove] = useState(false);
  const [ok, setOk] = useState(false);
  useEffect(() => { if (session == null && designers[0]) setSession(designers[0].id); }, [designers, session]);
  useEffect(() => { if (session != null) sessionApi.claudeOptions(session).then((o) => { setModels(o.models); setModel(o.pinnedModel); }, () => setModels([])); }, [session]);
  useEffect(() => { setOk(false); setApprove(false); }, [shot.id, region, baseline?.id, references]);
  const reviewActions = shot.status === 'candidate' && <div className="studio-review row wrap">
    <label className="row"><input type="checkbox" checked={approve} disabled={!reviewable || busy} onChange={(e) => setApprove(e.target.checked)} /> Revisé la captura y sus restricciones</label>
    <button className="btn sm danger" disabled={busy} onClick={() => onReview(false)}>Descartar</button>
    <button className="btn sm pearl" disabled={busy || !approve || !reviewable} onClick={() => onReview(true)}>Aprobar como referencia</button>
    {!reviewable && <span className="mut2">Captura con el tamaño de la referencia para aprobar.</span>}
  </div>;
  const selectable = selected != null || validRegion(region);
  const touches = locks.filter((l) => !isFull(region) && l.region.x < region.x + region.width && l.region.x + l.region.width > region.x && l.region.y < region.y + region.height && l.region.y + l.region.height > region.y);
  if (cmp) return (
    <div className="scomp cmpc">
      <div className="row wrap"><b>Antes → versión seleccionada</b><span className="mut2">{locks.length} {locks.length === 1 ? 'protección' : 'protecciones'} en la pantalla</span><span className="grow" />
        <div className="seg" role="group" aria-label="Modo de comparación">{([['split', 'compare', 'Divisor'], ['side', 'side', 'Lado a lado'], ['diff', 'diff', 'Diferencias']] as [Cmp, string, string][]).map(([id, ic, l]) => <button key={id} className={cmp === id ? 'on' : ''} aria-pressed={cmp === id} onClick={() => onCmp(id)}><Icon name={ic} size={13} />{l}</button>)}</div>
      </div>
      <div className="row wrap" style={{ marginTop: 8 }}><span className="grow" />
        <button className="btn sm ghost" onClick={() => onCmp(null)}>Salir de la comparación</button>
      </div>
      {reviewActions}
    </div>
  );
  if (!designers.length) return (
    <div className="scomp"><div className="row wrap"><span className="mut2">Crea una sesión Claude para enviar un encargo.</span>
      <button className="btn sm" disabled={busy} onClick={onNewSession}>Nueva sesión Claude</button></div>{reviewActions}</div>
  );
  return (
    <div className="scomp">
      <div className="row wrap">
        <span className="chip sky"><Icon name={isFull(region) ? 'screen' : 'region'} size={11} /> {isFull(region) ? 'Toda la pantalla' : selected?.name ?? `Región ${Math.round(region.x)},${Math.round(region.y)} · ${Math.round(region.width)}×${Math.round(region.height)} %`}</span>
        {touches.length > 0 && <span className="chip amber"><Icon name="lock" size={11} /> {touches.map((l) => l.text).join(', ')}: protegido, no se tocará</span>}
        <span className="grow" />
        {!isFull(region) && <button className="tbtn" onClick={onClear} aria-label="Quitar región" title="Quitar región"><Icon name="close" size={12} /></button>}
      </div>
      <textarea rows={2} value={text} onChange={(e) => { setText(e.currentTarget.value); setOk(false); }} placeholder={isFull(region) ? 'Qué cambiar en la pantalla (o pulsa R y marca una región)' : 'Qué cambiar en esta región'} aria-label="Encargo de diseño" className="in" style={{ width: '100%', marginTop: 8 }} />
      <div className="row wrap" style={{ marginTop: 6 }}>
        <label className="fsel"><select value={session ?? ''} onChange={(e) => { setSession(Number(e.currentTarget.value)); setOk(false); }} aria-label="Sesión">{designers.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.branch ?? 'proyecto'}</option>)}</select><Icon name="down" size={11} /></label>
        {models.length > 0 && <label className="fsel"><select value={model ?? ''} onChange={(e) => { const v = e.currentTarget.value; sessionApi.setOption(session!, 'model', v).then(() => setModel(v || null)); }} aria-label="Modelo"><option value="">Modelo predeterminado</option>{models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select><Icon name="down" size={11} /></label>}
        <label className="row" style={{ fontSize: 12 }}><input type="checkbox" checked={ok} onChange={(e) => setOk(e.currentTarget.checked)} /> Enviar captura y protecciones{references ? ` con ${references} ${references === 1 ? 'referencia' : 'referencias'}` : ''}</label>
        <span className="grow" />
        <button className="btn sm ghost" onClick={() => session != null && onOpenSession(session)}>Conversación</button>
        <button className="btn sm" disabled={busy || !ok || !text.trim() || !selectable || session == null || !baseline || baseline.id === shot.id} onClick={() => { onSend(session!, text, true); setText(''); }} title="Comparar con la referencia sin editar archivos">Comparar</button>
        <button className="btn sm pearl" disabled={busy || !ok || !text.trim() || !selectable || session == null} onClick={() => { onSend(session!, text, false); setText(''); }}><Icon name="spark" size={12} /> Pedir cambio</button>
      </div>
      {reviewActions}
    </div>
  );
}

function StudioInsp({ screen, shot, region, parsed, busy, sent, size, candidateImage, referenceImage, components, selected, onSelect, references, onSize, onRegion, onSave, onCapture, onImport }: {
  screen: DesignScreen; shot: DesignShot | null; region: DesignRegion; parsed: { locks: Lock[]; rest: string }; busy: boolean; sent: { text: string; label: string; at: number }[]; size: [number, number];
  components?: DesignComponent[]; selected: DesignComponent | null; onSelect: (c: DesignComponent | null) => void; references: React.ReactNode;
  candidateImage?: string; referenceImage?: string; onSize: (size: [number, number]) => void; onRegion: (r: DesignRegion) => void; onSave: (locks: Lock[], rest: string) => void; onCapture: (note: string) => void; onImport: (f: File, note: string) => void;
}) {
  const [name, setName] = useState('');
  const [rest, setRest] = useState(parsed.rest);
  const [note, setNote] = useState('');
  const [wipe, setWipe] = useState(50);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => setRest(parsed.rest), [parsed.rest]);
  const full = isFull(region);
  const crop = (src: string, alt: string) => <img src={src} alt={alt} style={{
    width: `${10000 / region.width}%`, height: `${10000 / region.height}%`,
    left: `${-100 * region.x / region.width}%`, top: `${-100 * region.y / region.height}%`,
  }} />;
  return (
    <>
      <div className="sec"><span className="lab">Selección</span>
        {shot && components && components.length > 0 && <label className="studio-components">Componente
          <select className="in" value={selected?.selector ?? ''} onChange={(e) => onSelect(components.find((item) => item.selector === e.currentTarget.value) ?? null)}>
            <option value="">Seleccionar componente…</option>
            {components.map((item) => <option key={item.selector} value={item.selector}>{item.name} · {item.kind}</option>)}
          </select>
        </label>}
        {shot && components?.length === 0 && <p className="mut2">Esta versión permite marcar regiones. Para seleccionar componentes, captura una página local desde Studio.</p>}
        {shot && selected && <>
          <div className="row wrap"><h3 className="grow">{selected.name}</h3>
            <button className="btn sm" disabled={busy} onClick={() => {
              const locked = parsed.locks.some((item) => item.selector === selected.selector);
              onSave(locked ? parsed.locks.filter((item) => item.selector !== selected.selector)
                : [...parsed.locks, { region, selector: selected.selector, text: selected.name }], parsed.rest);
            }}><Icon name="lock" size={13} /> {parsed.locks.some((item) => item.selector === selected.selector) ? 'Desproteger componente' : 'Proteger componente'}</button>
          </div>
          <dl className="kv"><dt>Tamaño</dt><dd>{Math.round(selected.width)} × {Math.round(selected.height)} px</dd>
            <dt>Radio</dt><dd>{selected.radius}</dd><dt>Selector</dt><dd className="mono studio-selector">{selected.selector}</dd></dl>
        </>}
        {shot && !selected && <div className="studio-region-fields">{(['x', 'y', 'width', 'height'] as const).map((key) => (
          <label key={key}>{({ x: 'X', y: 'Y', width: 'Ancho', height: 'Alto' })[key]} %
            <input className="in" type="number" min={0} max={100} value={Math.round(region[key])} onChange={(event) => onRegion({ ...region, [key]: event.target.valueAsNumber || 0 })} />
          </label>
        ))}</div>}
        {shot && !full && validRegion(region) && candidateImage && referenceImage && <details className="studio-region-compare">
          <summary>Comparar esta región</summary>
          <label>Divisor de la región<input type="range" min={0} max={100} value={wipe} onChange={(e) => setWipe(e.currentTarget.valueAsNumber)} /></label>
          <div className="design-crop" style={{ aspectRatio: shot.width * region.width / (shot.height * region.height) }}>
            {crop(referenceImage, 'Región de referencia')}
            <div className="design-crop-layer" style={{ clipPath: `inset(0 ${100 - wipe}% 0 0)` }}>
              {crop(candidateImage, 'Región de la versión')}
            </div>
          </div>
        </details>}
        {!validRegion(region) && <p role="status">La región debe quedar dentro de la pantalla.</p>}
        {selected ? null : full ? <p className="mut2">Usa <span className="kbd">V</span> para seleccionar un componente. Pulsa <span className="kbd">R</span> y marca una región en la captura para acotar el cambio; con <span className="kbd">H</span> mueves el lienzo y con <span className="kbd">C</span> comparas con la referencia.</p> : (
          <>
            <div className="row" style={{ marginTop: 6 }}><h3 className="grow">Región marcada</h3></div>
            <dl className="kv"><dt>Posición</dt><dd className="mono">{Math.round(region.x)} %, {Math.round(region.y)} %</dd><dt>Tamaño</dt><dd className="mono">{Math.round(region.width)} × {Math.round(region.height)} %{shot ? ` · ${Math.round((region.width / 100) * shot.width)} × ${Math.round((region.height / 100) * shot.height)} px` : ''}</dd></dl>
            <div className="row" style={{ marginTop: 8 }}>
              <input className="in" style={{ flex: 1 }} placeholder="Nombre (p. ej. cabecera)" value={name} onChange={(e) => setName(e.currentTarget.value)} aria-label="Nombre de la protección" />
              <button className="btn sm" disabled={busy || !name.trim() || !validRegion(region)} onClick={() => { onSave([...parsed.locks, { region, text: name }], parsed.rest); setName(''); }}><Icon name="lock" size={13} /> Proteger</button>
            </div>
          </>
        )}
      </div>
      <div className="sec"><span className="lab">Protegido · se conserva entre versiones</span>
        <div style={{ marginTop: 6 }}>
          {parsed.locks.length ? parsed.locks.map((l, i) => (
            <div key={i} className="lockrow"><Icon name="lock" size={13} /><button className="grow lnk" style={{ textAlign: 'left' }} onClick={() => { const component = l.selector && components?.find((item) => item.selector === l.selector); if (component) onSelect(component); else onRegion(l.region); }}>{l.text || 'Región sin nombre'}</button>
              <button className="tbtn" disabled={busy} onClick={() => onSave(parsed.locks.filter((_, j) => j !== i), parsed.rest)} aria-label="Desproteger" title="Desproteger"><Icon name="close" size={12} /></button></div>
          )) : <p className="mut2">Nada protegido todavía.</p>}
        </div>
        <label className="lab" style={{ display: 'block', marginTop: 10 }}>Restricciones generales</label>
        <textarea className="in" rows={3} style={{ width: '100%', marginTop: 4 }} value={rest} onChange={(e) => setRest(e.currentTarget.value)} aria-label="Restricciones generales" />
        <button className="btn sm" style={{ marginTop: 6 }} disabled={busy || rest === parsed.rest} onClick={() => onSave(parsed.locks, rest)}>Guardar restricciones</button>
      </div>
      <div className="sec"><span className="lab">Cambios pedidos · {sent.length}</span>
        <div style={{ marginTop: 6 }}>{sent.length ? sent.map((r, i) => <div key={i} className="req"><span className="n">{sent.length - i}</span><div><div>{r.text}</div><div className="mono mut2" style={{ fontSize: 11.5, marginTop: 2 }}>{r.label} · {new Date(r.at).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</div></div></div>) : <p className="mut2">Ninguno en esta sesión.</p>}</div>
      </div>
      {references}
      <div className="sec"><span className="lab">Nueva versión</span>
        <div className="studio-region-fields">
          <label>Ancho de captura<input className="in" type="number" min={64} max={4096} value={size[0] || ''} onChange={(event) => onSize([event.target.valueAsNumber || 0, size[1]])} /></label>
          <label>Alto de captura<input className="in" type="number" min={64} max={4096} value={size[1] || ''} onChange={(event) => onSize([size[0], event.target.valueAsNumber || 0])} /></label>
        </div>
        <input className="in" style={{ width: '100%', marginTop: 6 }} placeholder="Nota (opcional)" value={note} onChange={(e) => setNote(e.currentTarget.value)} aria-label="Nota de la versión" />
        <div className="row wrap" style={{ marginTop: 6 }}>
          <button className={`btn sm${busy ? ' busy' : ''}`} disabled={busy || !validSize(size) || !screen.url} onClick={() => { onCapture(note); setNote(''); }}><Icon name="screen" size={12} /> Capturar {size[0]} × {size[1]}</button>
          <button className="btn sm ghost" disabled={busy} onClick={() => file.current?.click()}><Icon name="attach" size={12} /> Importar PNG…</button>
          <input ref={file} type="file" accept="image/png" hidden onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) { onImport(f, note); setNote(''); } e.currentTarget.value = ''; }} />
        </div>
        <dl className="kv" style={{ marginTop: 10 }}><dt>URL</dt><dd className="mono">{screen.url}</dd><dt>Revisión</dt><dd>{screen.revision ?? '—'}</dd>{shot && <><dt>Versión</dt><dd className="mono">{shot.width} × {shot.height} · {shot.source}</dd></>}</dl>
      </div>
    </>
  );
}

function ScreenForm({ screen, onClose, onSave }: { screen: DesignScreen; onClose: () => void; onSave: (s: DesignScreen) => void }) {
  const [form, setForm] = useState(screen);
  return (
    <Modal title={screen.id == null ? 'Nueva pantalla' : 'Editar pantalla'} onClose={onClose}>
      <div className="tr-col">
        <label className="tr-field-row">Nombre<input value={form.name} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} /></label>
        <label className="tr-field-row">URL local (opcional)<input value={form.url} placeholder="http://localhost:5173/" onChange={(e) => setForm({ ...form, url: e.currentTarget.value })} /></label>
      </div>
      <div className="acts"><button className="tr-btn ghost" onClick={onClose}>Cancelar</button><button className="tr-btn pearl" disabled={!form.name.trim()} onClick={() => onSave(form)}>Guardar</button></div>
    </Modal>
  );
}
