import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import FileTree from './FileTree';
import { sharing, type GuestShare, type HostedShare } from './ipc';

export type ShareTarget = { path: string; name: string; session: number | null; worktree?: string };
type Props = {
  target: ShareTarget | null;
  onClose: () => void;
};

export default function Sharing({ target, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const invitationInput = useRef<HTMLInputElement>(null);
  const [relay, setRelay] = useState(() => {
    try { return localStorage.getItem('filigranas.relay') ?? ''; } catch { return ''; }
  });
  const [key, setKey] = useState('');
  const [invitation, setInvitation] = useState('');
  const [host, setHost] = useState<HostedShare | null>(null);
  const [guest, setGuest] = useState<GuestShare | null>(null);
  const [editable, setEditable] = useState(false);
  const [busy, setBusy] = useState(Boolean(target));
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  useEffect(() => {
    if (!target) return;
    let active = true;
    sharing.current().then(
      (value) => { if (active) setHost(value); },
      (reason) => { if (active) setError(String(reason)); },
    ).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [target]);

  useEffect(() => {
    if (!host) return;
    let active = true;
    let timer: number;
    const check = async () => {
      const current = await sharing.current().catch(() => host);
      if (!active) return;
      if (current) {
        setHost((previous) => previous?.editable === current.editable ? previous : current);
        timer = window.setTimeout(check, 3000);
      } else setHost(null);
    };
    timer = window.setTimeout(check, 3000);
    return () => { active = false; window.clearTimeout(timer); };
  }, [host]);

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      if (target) {
        const value = await sharing.start(target.path, target.session, relay, key, editable);
        setHost(value);
        setCopied(false);
        setKey('');
        try { localStorage.setItem('filigranas.relay', relay.trim()); } catch { /* preferencia opcional */ }
      } else {
        setGuest(await sharing.join(invitation));
        setInvitation('');
      }
    });
  };

  const setAccess = (value: boolean) => {
    void run(async () => {
      try {
        setHost(await sharing.access(value));
      } catch (reason) {
        const current = await sharing.current().catch(() => host);
        setHost(current);
        throw reason;
      }
    });
  };

  const updateGuestAccess = useCallback((editable: boolean) => {
    setGuest((previous) => previous && previous.editable !== editable ? { ...previous, editable } : previous);
  }, []);

  const quit = () => {
    if (guest) {
      void run(async () => {
        await sharing.leave();
        onClose();
      });
    } else {
      onClose();
    }
  };

  const copy = async () => {
    if (!host) return;
    try {
      await navigator.clipboard.writeText(host.invitation);
      setCopied(true);
    } catch {
      invitationInput.current?.select();
    }
  };

  return (
    <dialog ref={dialog} className={`share-dialog${guest ? ' is-viewer' : ''}`} aria-labelledby="share-title"
      onCancel={(event) => { event.preventDefault(); if (!busy) quit(); }}>
      <header>
        <h2 id="share-title">{guest?.name ?? (target ? 'Compartir proyecto' : 'Unirse a un proyecto')}</h2>
        {guest && <span className="tag">{guest.editable ? 'Puede editar' : 'Solo lectura'}</span>}
        <button className="co-btn share-close" onClick={quit} disabled={busy}>{guest ? 'Salir del proyecto' : 'Cerrar'}</button>
      </header>
      {guest ? <RemoteFiles editable={guest.editable} onAccess={updateGuestAccess} /> : host ? (
        <div className="share-form">
          <p>Compartiendo {host.name}. Mantén Filigranas abierto.</p>
          <AccessSelect editable={host.editable} disabled={busy} onChange={setAccess} />
          <label>Invitación de un solo uso
            <input ref={invitationInput} value={host.invitation} readOnly onFocus={(e) => e.currentTarget.select()} />
          </label>
          <p className="muted">Caduca a las {new Date(host.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.</p>
          <div className="share-actions">
            <button className="co-btn is-primary" onClick={() => void copy()} disabled={busy}>{copied ? 'Copiada' : 'Copiar invitación'}</button>
            <button className="co-btn" disabled={busy} onClick={() => void run(async () => { await sharing.stop(); setHost(null); })}>Dejar de compartir</button>
          </div>
        </div>
      ) : (
        <form className="share-form" onSubmit={submit}>
          {target ? <>
            <p>{target.name}{target.worktree ? ` · ${target.worktree}` : ''}</p>
            <AccessSelect editable={editable} disabled={busy} onChange={setEditable} />
            <p className="muted">{editable
              ? 'El invitado puede guardar cambios en los archivos de texto ya añadidos a Git.'
              : 'El invitado puede leer los archivos de texto ya añadidos a Git.'}</p>
            <label>Dirección del servicio
              <input value={relay} onChange={(e) => setRelay(e.target.value)} placeholder="https://…" required spellCheck={false} autoComplete="off" />
            </label>
            <label>Clave del servicio
              <input value={key} onChange={(e) => setKey(e.target.value)} type="password" required autoComplete="off" />
            </label>
          </> : (
            <label>Invitación de Filigranas
              <input value={invitation} onChange={(e) => setInvitation(e.target.value)} required spellCheck={false} autoComplete="off" />
            </label>
          )}
          <div className="share-actions">
            <button className="co-btn is-primary" disabled={busy}>{target ? 'Crear invitación' : 'Unirse'}</button>
          </div>
        </form>
      )}
      {error && <p className="error share-error" role="alert">{error}</p>}
    </dialog>
  );
}

function AccessSelect({ editable, disabled, onChange }: { editable: boolean; disabled: boolean; onChange: (value: boolean) => void }) {
  return (
    <label>Permiso del invitado
      <select value={editable ? 'edit' : 'read'} disabled={disabled} onChange={(e) => onChange(e.currentTarget.value === 'edit')}>
        <option value="read">Solo lectura</option>
        <option value="edit">Puede editar</option>
      </select>
    </label>
  );
}

type Draft = { base: string; text: string };

function RemoteFiles({ editable, onAccess }: { editable: boolean; onAccess: (editable: boolean) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [connection, setConnection] = useState<'online' | 'offline' | 'closed'>('online');
  const drafts = useRef(new Map<string, Draft>());

  useEffect(() => {
    let active = true;
    let timer: number;
    const check = async () => {
      try {
        const { online, closed, editable } = await sharing.status();
        if (!active) return;
        setConnection(closed ? 'closed' : online ? 'online' : 'offline');
        onAccess(!closed && editable);
        if (closed) return;
      } catch {
        if (!active) return;
        setConnection('offline');
      }
      timer = window.setTimeout(check, 3000);
    };
    void check();
    return () => { active = false; window.clearTimeout(timer); };
  }, [onAccess]);

  if (connection === 'closed') {
    const paths = [...drafts.current.keys()];
    const path = selected && drafts.current.has(selected) ? selected : paths[0];
    return <>
      <p className="share-message" role="status">La sesión compartida ha terminado.</p>
      {path && <div className="share-form">
        <label>Borrador sin guardar
          <select value={path} onChange={(e) => setSelected(e.currentTarget.value)}>
            {paths.map((file) => <option key={file} value={file}>{file}</option>)}
          </select>
        </label>
        <textarea className="share-editor" aria-label="Texto del borrador" readOnly value={drafts.current.get(path)?.text} />
      </div>}
    </>;
  }

  return <>
    {connection === 'offline' && <p className="share-message" role="status">Conexión interrumpida. Intentando reconectar…</p>}
    <div className="share-files">
      <aside aria-label="Archivos compartidos">
        <div className="share-files-head">
          <span>Archivos</span>
          <button className="co-btn" disabled={connection !== 'online'} onClick={() => setRevision((v) => v + 1)}>Actualizar</button>
        </div>
        <FileTree key={revision} root="" selected={selected} onOpen={setSelected} list={sharing.list} />
      </aside>
      <section aria-label="Vista del archivo">
        {selected ? <RemoteFile key={selected} path={selected} revision={revision} drafts={drafts.current}
          editable={editable} online={connection === 'online'} />
          : <p className="share-message">Selecciona un archivo para abrirlo.</p>}
      </section>
    </div>
  </>;
}

function RemoteFile({ path, revision, drafts, editable, online }: {
  path: string;
  revision: number;
  drafts: Map<string, Draft>;
  editable: boolean;
  online: boolean;
}) {
  const [current, setCurrent] = useState<string | null>(null);
  const [draft, setDraft] = useState(() => drafts.get(path));
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const mounted = useRef(false);
  const version = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!online || busy) return;
    let active = true;
    let timer: number;
    const refresh = async () => {
      try {
        const file = await sharing.read(path, version.current);
        if (!active || saving.current) return;
        setReadError(null);
        if (file) {
          version.current = file.revision;
          setCurrent(file.text);
          if (drafts.get(path)?.text === file.text) {
            drafts.delete(path);
            setDraft(undefined);
            setError(null);
          }
        }
      } catch (reason) {
        if (!active || saving.current) return;
        setReadError(String(reason));
      }
      timer = window.setTimeout(refresh, 2000);
    };
    void refresh();
    return () => { active = false; window.clearTimeout(timer); };
  }, [path, revision, online, busy, drafts]);

  const save = async () => {
    if (!draft || !editable || !online || saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await sharing.write(path, draft.base, draft.text);
      if (drafts.get(path) === draft) drafts.delete(path);
      if (mounted.current) {
        version.current = null;
        setReadError(null);
        setCurrent(draft.text);
        setDraft(undefined);
        setSaved(true);
      }
    } catch (reason) {
      if (mounted.current) setError(String(reason));
    } finally {
      saving.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const update = (text: string) => {
    const base = drafts.get(path)?.base ?? current;
    if (base === null) return;
    const next = base === text ? undefined : { base, text };
    if (next) drafts.set(path, next);
    else drafts.delete(path);
    setDraft(next);
    setSaved(false);
  };

  const conflict = draft && current !== null && current !== draft.base && current !== draft.text;

  return <>
    <div className="share-file-path">
      <span>{path}</span>
      {editable && <button className="co-btn is-primary" disabled={!draft || busy || !online || !!conflict}
        onClick={() => void save()}>{busy ? 'Guardando…' : 'Guardar cambios'}</button>}
    </div>
    {(error || readError) && <p className="share-message error" role="alert">{error || readError}</p>}
    {saved && <p className="share-message" role="status">Cambios guardados.</p>}
    {conflict && <details className="share-file-conflict">
      <summary>Hay cambios guardados. Ver versión actual</summary>
      <pre>{current}</pre>
      {editable && <button className="co-btn" disabled={busy || !online} onClick={() => {
        const next = { base: current, text: draft.text };
        drafts.set(path, next);
        setDraft(next);
        setError(null);
      }}>Mantener mi borrador sobre esta versión</button>}
    </details>}
    {current === null && !draft
      ? !readError && <p className="share-message" role="status">Abriendo archivo…</p>
      : editable || draft
        ? <textarea className="share-editor" aria-label={path} spellCheck={false} value={draft?.text ?? current ?? ''}
            readOnly={!editable || !online || busy}
            onChange={(e) => {
              const value = e.currentTarget.value;
              const base = draft?.base ?? current;
              update(base?.includes('\r\n') && !base.replaceAll('\r\n', '').includes('\n') ? value.replaceAll('\n', '\r\n') : value);
            }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                if (!conflict) void save();
              }
            }} />
        : <pre tabIndex={0} aria-label={path}>{current}</pre>}
  </>;
}
