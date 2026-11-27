import type { CheckLog, CommitDetail, PullDetail } from '../../ipc';
import type { ReviewNote } from '../findings';
import { Icon } from '../icons';
import type { TreeFileItem } from './entregaStore';

export type InspectorPayload =
  | { kind: 'file'; file: TreeFileItem; findings: ReviewNote[] }
  | { kind: 'commit'; detail: CommitDetail; onOpenFile: (path: string) => void }
  | { kind: 'log'; title: string; log: CheckLog }
  | { kind: 'pr'; detail: PullDetail };

type Props = {
  payload: InspectorPayload;
  onClose: () => void;
};

export function ContextInspector({ payload, onClose }: Props) {
  return (
    <aside className="ent-insp" aria-label="Inspector contextual">
      <div className="ent-insp-head">
        <strong>
          {payload.kind === 'file' && 'Detalle de archivo'}
          {payload.kind === 'commit' && `Commit ${payload.detail.hash.slice(0, 7)}`}
          {payload.kind === 'log' && `Log CI · ${payload.title}`}
          {payload.kind === 'pr' && `Resumen PR #${payload.detail.number}`}
        </strong>
        <button className="tbtn" onClick={onClose} title="Cerrar inspector" aria-label="Cerrar inspector">
          <Icon name="close" size={13} />
        </button>
      </div>

      <div className="ent-insp-body">
        {payload.kind === 'file' && (
          <div className="ent-insp-sec">
            <div className="mono ent-break">{payload.file.path}</div>
            {payload.file.orig && <div className="mut mono">Desde: {payload.file.orig}</div>}
            <div className="ent-row-wrap" style={{ marginTop: 8 }}>
              <span className="chip tiny">Estado: {payload.file.status}</span>
              {payload.file.staged && <span className="chip mint tiny">Staged ({payload.file.staged})</span>}
              {payload.file.unstaged && <span className="chip amber tiny">Unstaged ({payload.file.unstaged})</span>}
              {payload.file.adds != null && <span className="chip tiny add">+{payload.file.adds}</span>}
              {payload.file.dels != null && <span className="chip tiny del">-{payload.file.dels}</span>}
            </div>
            <div className="lab" style={{ marginTop: 14 }}>Hallazgos en este archivo ({payload.findings.length})</div>
            {payload.findings.length === 0 ? (
              <p className="mut">Sin hallazgos abiertos.</p>
            ) : (
              payload.findings.map((f) => (
                <div key={f.fingerprint} className="ent-insp-item">
                  <span className={`sev ${f.severity === 'error' ? 'h' : f.severity === 'warning' ? 'm' : 'l'}`} />
                  <div>
                    <div>{f.title ?? f.rule}</div>
                    <div className="mut mono">Línea {f.line ?? '—'} · {f.rule}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {payload.kind === 'commit' && (
          <div className="ent-insp-sec">
            <dl className="kv">
              <dt>SHA</dt><dd className="mono">{payload.detail.hash.slice(0, 12)}</dd>
              <dt>Autor</dt><dd>{payload.detail.author}</dd>
              <dt>Fecha</dt><dd>{payload.detail.date}</dd>
            </dl>
            <pre className="ent-pr-body">{payload.detail.body}</pre>
            <div className="lab" style={{ marginTop: 10 }}>Archivos ({payload.detail.files.length})</div>
            {payload.detail.files.map((f) => (
              <button key={f.path} className="ent-insp-file" onClick={() => payload.onOpenFile(f.path)}>
                <span className={`ent-st ent-st-${f.status.toLowerCase()}`}>{f.status}</span>
                <span className="mono ent-tname">{f.path}</span>
                <span className="mono mut">
                  {f.adds != null ? `+${f.adds}` : ''} {f.dels != null ? `-${f.dels}` : ''}
                </span>
              </button>
            ))}
          </div>
        )}

        {payload.kind === 'log' && (
          <div className="ent-insp-sec">
            {payload.log.untrusted && (
              <div className="ent-warn-banner" style={{ marginBottom: 8 }}>
                <Icon name="shield" size={13} />
                <span>Salida externa de GitHub (datos no confiables; tokens redactados).</span>
              </div>
            )}
            {payload.log.truncated && <p className="mut">Mostrando los últimos 120 KB del log.</p>}
            <pre className="ent-log-pre mono">{payload.log.content || 'Sin salida de log.'}</pre>
          </div>
        )}

        {payload.kind === 'pr' && (
          <div className="ent-insp-sec">
            <dl className="kv">
              <dt>Estado</dt><dd>{payload.detail.state}{payload.detail.isDraft ? ' (Draft)' : ''}</dd>
              <dt>Origen</dt><dd className="mono">{payload.detail.branch}</dd>
              <dt>Destino</dt><dd className="mono">{payload.detail.base}</dd>
              <dt>Head SHA</dt><dd className="mono">{payload.detail.headOid.slice(0, 10)}</dd>
              <dt>Mergeable</dt><dd>{payload.detail.mergeable} ({payload.detail.mergeState})</dd>
              <dt>Revisión</dt><dd>{payload.detail.reviewDecision ?? 'Pendiente'}</dd>
            </dl>
          </div>
        )}
      </div>
    </aside>
  );
}
