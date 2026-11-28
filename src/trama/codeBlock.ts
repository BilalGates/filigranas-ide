import React, { Children, createContext, isValidElement, useContext, type ComponentType, type ReactNode } from 'react';
import type { Components } from 'react-markdown';
import { readArchitecture } from './conversationContent.ts';

type Architecture = NonNullable<ReturnType<typeof readArchitecture>>;
export const FlowContext = createContext<(() => void) | undefined>(undefined);

export function createCodeComponents(
  ArchitectureView: ComponentType<{ data: Architecture; onOpen?: () => void }>,
  Copy: ComponentType<{ text: string; label: string }>,
): Components {
  function CodeBlock({ children }: { children?: ReactNode }) {
    const onOpen = useContext(FlowContext);
    const code = Children.toArray(children)[0];
    if (!isValidElement<{ className?: string; children?: ReactNode }>(code))
      return React.createElement('pre', { className: 'co-code' }, children);
    const lang = code.props.className?.replace(/^language-/, '') ?? '';
    const body = String(code.props.children ?? '').replace(/\n$/, '');
    const architecture = lang === 'mermaid' ? readArchitecture(body) : null;
    if (architecture) return React.createElement(ArchitectureView, { data: architecture, onOpen });
    return React.createElement('div', { className: 'co-code-wrap' },
      React.createElement('div', { className: 'co-code-bar' },
        React.createElement('span', { className: 'co-code-lang' }, lang || 'bloque'),
        React.createElement(Copy, { text: body, label: 'Copiar bloque' })),
      React.createElement('pre', { className: 'co-code' }, React.createElement('code', null, body)));
  }
  return { pre: CodeBlock };
}
