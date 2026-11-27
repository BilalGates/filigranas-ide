import { useEffect, useId, useRef, useState } from 'react';
import type { ChatEngine } from './ipc';
import ProviderLogo from './ProviderLogo';

export type ProviderSwitch = {
  engine: ChatEngine;
  disabled: boolean;
  title: string;
  onChange: (engine: ChatEngine) => void;
};

export type ModelOption = {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
};

export type ReasoningOption = {
  value: string;
  label: string;
  shortLabel?: string;
  hint?: string;
};

export type ReasoningGroup = {
  id: string;
  heading: string;
  value: string;
  disabled?: boolean;
  options: ReasoningOption[];
  onChange: (value: string) => void;
};

type Props = {
  /** Clave estable del chat (p. ej. `pm:<ruta>` o `session:<id>`) para mantener abierto el panel al cambiar de proveedor. */
  persistKey?: string;
  hidden?: boolean;
  switching?: boolean;
  loadingModels?: boolean;
  engine: string;
  engineLabel: string;
  provider?: ProviderSwitch;
  modelDisplay: string;
  model?: {
    value: string;
    options: ModelOption[];
    disabled?: boolean;
    onChange: (value: string) => void;
  };
  reasoning?: ReasoningGroup[];
  reasoningDisplay?: string;
  disabled?: boolean;
  title?: string;
};

const PROVIDERS: { value: ChatEngine; label: string; vendor: string }[] = [
  { value: 'codex', label: 'Codex', vendor: 'OpenAI' },
  { value: 'claude', label: 'Claude Code', vendor: 'Anthropic' },
];

// Mantiene abierto el panel aunque cambiar de proveedor desmonte y vuelva a montar la vista del chat.
const openMenus = new Set<string>();

/**
 * Selector unificado del compositor: reúne proveedor, modelo y nivel de
 * razonamiento en un único botón con panel emergente hacia arriba.
 */
export default function ModelConfigMenu({
  persistKey,
  hidden,
  switching,
  loadingModels,
  engine,
  engineLabel,
  provider,
  modelDisplay,
  model,
  reasoning,
  reasoningDisplay,
  disabled,
  title,
}: Props) {
  const restored = useRef(Boolean(persistKey && openMenus.has(persistKey)));
  const [open, setOpenState] = useState(() => restored.current);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const setOpen = (next: boolean) => {
    restored.current = false;
    if (persistKey) {
      if (next) openMenus.add(persistKey);
      else openMenus.delete(persistKey);
    }
    setOpenState(next);
  };

  const activeReasoning = (reasoning ?? []).filter((g) => g.options.length > 0);
  const hasMenu = Boolean(provider || (model && model.options.length > 0) || activeReasoning.length > 0);

  useEffect(() => {
    if (hidden && open) setOpen(false);
  }, [hidden, open]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, persistKey]);

  const summaryParts = [engineLabel, modelDisplay, reasoningDisplay].filter((part): part is string => Boolean(part));
  const ariaSummary = summaryParts.join(' · ');

  if (!hasMenu) {
    return (
      <span className="chip is-static mcm-static" title={title ?? ariaSummary}>
        <ProviderLogo engine={engine} />
        <span className="cm-value">{ariaSummary}</span>
      </span>
    );
  }

  return (
    <div className="cm mcm" ref={root}>
      <button
        ref={trigger}
        type="button"
        className={`chip cm-trigger mcm-trigger${open ? ' is-open' : ''}`}
        aria-label={`Configuración del modelo: ${ariaSummary}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled && !open}
        title={title ?? ariaSummary}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <ProviderLogo engine={engine} />
        <span className="mcm-summary">
          <span className="mcm-part is-engine">{engineLabel}</span>
          {modelDisplay && (
            <>
              <span className="mcm-sep" aria-hidden="true">·</span>
              <span className="mcm-part is-model">{modelDisplay}</span>
            </>
          )}
          {reasoningDisplay && (
            <>
              <span className="mcm-sep" aria-hidden="true">·</span>
              <span className="mcm-part is-effort">{reasoningDisplay}</span>
            </>
          )}
        </span>
        <svg className="cm-caret" width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
          <path d="M2.5 6.2 5 3.8l2.5 2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          className={`cm-menu mcm-menu${restored.current ? ' is-restored' : ''}`}
          id={menuId}
          role="dialog"
          aria-label="Proveedor, modelo y razonamiento"
        >
          {provider && (
            <div className="mcm-section">
              <div className="mcm-head">
                <span className="cm-heading">Proveedor</span>
                {switching && <span className="mcm-status">Cambiando…</span>}
              </div>
              <div className="mcm-providers" role="radiogroup" aria-label="Proveedor" title={provider.disabled ? provider.title : undefined}>
                {PROVIDERS.map((p) => {
                  const selected = provider.engine === p.value;
                  return (
                    <button
                      key={p.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      disabled={provider.disabled}
                      className={`mcm-provider${selected ? ' is-on' : ''}`}
                      onClick={() => {
                        if (!selected) provider.onChange(p.value);
                      }}
                    >
                      <ProviderLogo engine={p.value} size={15} />
                      <span className="mcm-provider-text">
                        <span>{p.label}</span>
                        <small>{p.vendor}</small>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="mcm-section">
            <div className="mcm-head">
              <span className="cm-heading">Modelo</span>
              {loadingModels && <span className="mcm-status">Cargando…</span>}
            </div>
            {model && model.options.length > 0 ? (
              <div className="mcm-models" role="radiogroup" aria-label="Modelo">
                {model.options.map((o) => {
                  const selected = o.value === model.value;
                  return (
                    <button
                      key={o.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      disabled={model.disabled || o.disabled}
                      className={`cm-item${selected ? ' is-on' : ''}`}
                      onClick={() => {
                        if (!selected && !o.disabled) model.onChange(o.value);
                      }}
                    >
                      <span className="cm-text">
                        <span className="cm-label">{o.label}</span>
                        {o.hint && <small>{o.hint}</small>}
                      </span>
                      <svg className="cm-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        {selected && <path d="M5 12.5l4.5 4.5L19 7" strokeLinecap="round" strokeLinejoin="round" />}
                      </svg>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="mcm-static-row">{loadingModels ? 'Cargando modelos…' : (modelDisplay || 'Automático')}</div>
            )}
          </div>

          {activeReasoning.map((group) => {
            const currentOption = group.options.find((o) => o.value === group.value);
            return (
              <div key={group.id} className="mcm-section">
                <div className="mcm-head">
                  <span className="cm-heading">{group.heading}</span>
                </div>
                <div className="mcm-pills" role="radiogroup" aria-label={group.heading}>
                  {group.options.map((o) => {
                    const selected = o.value === group.value;
                    return (
                      <button
                        key={o.value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        disabled={group.disabled}
                        title={o.hint ?? o.label}
                        className={`mcm-pill${selected ? ' is-on' : ''}`}
                        onClick={() => {
                          if (!selected) group.onChange(o.value);
                        }}
                      >
                        {o.shortLabel ?? o.label}
                      </button>
                    );
                  })}
                </div>
                {currentOption?.hint && <p className="mcm-hint">{currentOption.hint}</p>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
