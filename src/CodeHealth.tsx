import { useEffect, useState } from 'react';
import { health, pr, type HealthCheck, type HealthFinding, type HealthRun, type PrInfo, type Session } from './ipc';
import { CHECK_STATE } from './Publish';

const CHECKS: Record<HealthCheck, string> = {
  diff: 'git diff --check', build: 'npm run build', typecheck: 'npm run typecheck', lint: 'npm run lint', test: 'npm run test',
  cargo_check: 'cargo check', cargo_test: 'cargo test', cargo_clippy: 'cargo clippy',
};
const OUTCOMES: Record<string, string> = {
  passed: 'correcto', failed: 'falló', findings: 'con hallazgos', incomplete: 'incompleto', unknown: 'resultado desconocido',
};
const SEVERITIES: Record<string, string> = { error: 'error', warning: 'aviso', note: 'nota', unknown: 'sin severidad' };

type Props = {
  project: string;
  session: Pick<Session, 'id' | 'worktree'> | null;
  closed: boolean;
  onFile: (path: string, session: number | null, root: string | null) => void;
};

export default function CodeHealth({ project, session: chosen, closed, onFile }: Props) {
  const session = chosen?.id ?? null;
  const [state, setState] = useState<{ session: number | null; runs: HealthRun[]; ci: PrInfo[] }>();
  const [check, setCheck] = useState<HealthCheck>('diff');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const current = state?.session === session ? state : undefined;
  const load = async () => {
    const [runs, ci] = await Promise.all([health.list(project, session), health.ci(project, session)]);
    return { session, runs, ci };
  };
  useEffect(() => {
    let active = true;
    load().then((result) => { if (active) setState(result); }, (e) => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [project, session]);

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      setState(await load());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return <section className="coach" aria-label="Code Health">
    <div className="co-log p5-panel">
      {closed ? <p className="muted">Evidencia guardada. Retoma la sesión para ejecutar comprobaciones o importar un informe.</p> :
      <div className="p5-actions task-form">
        <label>Comprobación local<select disabled={busy} value={check} onChange={(e) => setCheck(e.target.value as HealthCheck)}>
          {Object.entries(CHECKS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select></label>
        <button className="co-btn" disabled={busy} onClick={() => void act(() => health.run(project, session, check))}>
          {busy ? 'Procesando…' : 'Ejecutar comprobación'}
        </button>
        <label className="co-btn p5-upload">Importar SARIF
          <input type="file" accept=".sarif,.json,application/json" disabled={busy} onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = '';
            if (file) void act(async () => {
              if (file.size > 8 * 1024 * 1024) throw new Error('El informe supera 8 MiB');
              await health.import(project, session, await file.text());
            });
          }} />
        </label>
      </div>}
      {!closed && check !== 'diff' && <p className="muted">La comprobación ejecutará el código de compilación o pruebas del ámbito seleccionado.</p>}
      {error && <p className="co-error" role="alert">{error}</p>}
      <section aria-label="CI de GitHub" className="p5-section">
        <h2>CI de GitHub</h2>
        {current && current.ci.length === 0 && <p className="muted">Esta rama aún no tiene una observación de CI guardada.</p>}
        {current?.ci.map((pull) => <p key={pull.url}>
          <button className="co-link" onClick={() => pr.open(pull.url).catch((e) => setError(String(e)))}>PR #{pull.number}</button>
          {' · Último estado observado · '}{CHECK_STATE[pull.checksState]} · SHA <code>{pull.head.slice(0, 12)}</code> · {new Date(pull.observedAt * 1000).toLocaleString()}
        </p>)}
      </section>
      <section aria-label="Evidencia local" className="p5-section">
        <h2>Evidencia local</h2>
        {current && current.runs.length === 0 && <p className="muted">No hay comprobaciones guardadas en este ámbito.</p>}
        {current?.runs.map((run) => <details key={run.id} className="p5-record">
          <summary>{run.source} · {run.tool} {run.version ?? 'versión desconocida'} · {OUTCOMES[run.outcome]} · {new Date(run.observed * 1000).toLocaleString()}</summary>
          <p className="muted">{run.task != null && `Tarea #${run.task} · `}SHA {run.revision ?? 'desconocido'}
            {run.digest && <> · informe <code title={run.digest}>{run.digest.slice(0, 16)}</code></>}</p>
          {run.findings.map((finding) => <FindingRow key={`${finding.fingerprint}:${finding.status}:${finding.resolution}`}
            finding={finding} busy={busy}
            onFile={(path) => {
              health.file(project, session, path).then((absolute) => onFile(absolute, chosen?.worktree ? session : null, chosen?.worktree ?? null), (e) => setError(String(e)));
            }}
            onSave={(status, resolution) => act(() => health.resolve(project, session, run.id, finding.fingerprint, status, resolution))} />)}
        </details>)}
      </section>
    </div>
  </section>;
}

function FindingRow({ finding, busy, onFile, onSave }: {
  finding: HealthFinding; busy: boolean; onFile: (path: string) => void;
  onSave: (status: string, resolution: string) => Promise<void>;
}) {
  const [status, setStatus] = useState(finding.status);
  const [resolution, setResolution] = useState(finding.resolution);
  return <article className="p5-finding">
    <p><strong>{SEVERITIES[finding.severity]} · {finding.rule}</strong>{' · '}{finding.previous ? 'observado antes' : 'primera observación'}</p>
    {finding.path ? <button className="co-link" onClick={() => onFile(finding.path!)}>
      {finding.path}{finding.line != null ? `:${finding.line}` : ''}
    </button> : <span className="muted">Archivo local sin resolver{finding.line != null && ` · línea ${finding.line}`}</span>}
    <form className="task-form p5-actions" onSubmit={(e) => { e.preventDefault(); void onSave(status, resolution); }}>
      <label>Estado<select value={status} onChange={(e) => setStatus(e.target.value)} disabled={busy}>
        <option value="open">Abierto</option><option value="resolved">Resuelto</option><option value="accepted">Aceptado</option>
      </select></label>
      <label>Resolución<input value={resolution} onChange={(e) => setResolution(e.target.value)}
        maxLength={1000} required={status !== 'open'} disabled={busy} /></label>
      <button className="co-btn" disabled={busy || (status === finding.status && resolution === finding.resolution)}>Guardar</button>
    </form>
  </article>;
}
