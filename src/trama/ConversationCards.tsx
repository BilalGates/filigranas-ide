import { memo, useMemo, type ReactNode } from 'react';
import type { CItem, Change } from '../ipc';
import { Icon } from './icons';
import { readArchitecture, readDiffPreview } from './conversationContent';

export function ConversationCard({ label, icon, title, detail, action, children, className = '' }: {
  label: string; icon: string; title: string; detail?: ReactNode; action?: ReactNode; children: ReactNode; className?: string;
}) {
  return <section className={`co-rich-plan ${className}`} aria-label={label}>
    <div className="co-plan-head"><Icon name={icon} size={14} /><b>{title}</b>{detail}<span className="grow" />{action}</div>
    {children}
  </section>;
}

export const ConversationArchitecture = memo(function ConversationArchitecture({ data, onOpen }: {
  data: NonNullable<ReturnType<typeof readArchitecture>>;
  onOpen?: () => void;
}) {
  const { nodes, edges } = data;
  const width = 718, height = 86;
  const step = (width - 120) / (nodes.length - 1);
  const half = Math.min(50, Math.floor(step / 2 - 8));
  const coordinates = (index: number) => 60 + index * step;
  return <ConversationCard label="Arquitectura propuesta" icon="layers" title={data.title ?? nodes.map((node) => node.label).join(' → ')}
    action={onOpen && <button className="co-btn" onClick={onOpen}>Ver flujo</button>}>
    <svg className="co-architecture" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={nodes.map(({ label }) => label).join(' → ')}>
      {edges.map((label, i) => <g key={nodes[i].id}>
        <path className={label ? 'is-live' : undefined} d={`M${coordinates(i) + half + 2},43 L${coordinates(i + 1) - half - 2},43`} />
        {label && <text className="co-arch-edge" x={coordinates(i) + step / 2} y={19} textAnchor="middle">{label}</text>}
      </g>)}
      {nodes.map(({ id, label, detail }, i) => <g key={id} transform={`translate(${coordinates(i)},43)`}>
        <rect x={-half} y={-17} width={half * 2} height={34} rx={7} />
        <text y={detail ? -1 : 4} textAnchor="middle">{label}</text>
        {detail && <text y={11} className="co-arch-detail" textAnchor="middle">{detail}</text>}
      </g>)}
    </svg>
  </ConversationCard>;
});

export const ConversationChange = memo(function ConversationChange({ change, path, status, onDiff }: {
  change: NonNullable<CItem['changes']>[number]; path: string; status?: string; onDiff: (c: Change) => void;
}) {
  const kind = change.kind.type === 'add' ? 'A' : change.kind.type === 'delete' ? 'D' : 'M';
  const preview = useMemo(() => readDiffPreview(change.diff), [change.diff]);
  const open = () => onDiff({ path, orig: null, status: kind, adds: preview?.adds ?? null, dels: preview?.dels ?? null });
  if (!preview) return <button className="co-file" onClick={open} title="ver diff"><span className={`co-status is-${status}`}>{kind}</span> {path}</button>;
  return <ConversationCard label={`Vista previa de ${path}`} icon="file" title={path.split('/').at(-1) ?? path}
    detail={<><span className="co-patch-add">+{preview.adds}</span><span className="co-patch-del">−{preview.dels}</span></>}
    action={<button className="co-btn" onClick={open} title={path}>Abrir en el editor</button>}>
    <pre className="co-patch">{preview.lines.map(({ kind, text }, i) => <code key={i} className={`co-patch-${kind}`}>{text}</code>)}</pre>
  </ConversationCard>;
});
