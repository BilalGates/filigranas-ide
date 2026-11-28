import React, { memo, useState, type MouseEvent } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] };
function literalHtml() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (node.type === 'html') node.type = 'text';
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

export function externalHttpUrl(href: string | undefined): string | null {
  if (!href || !/^https?:\/\//i.test(href)) return null;
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}

export function followLink(event: Pick<MouseEvent, 'preventDefault'>, href: string | undefined, open: (url: string) => void) {
  event.preventDefault();
  const url = externalHttpUrl(href);
  if (url) open(url);
}

function SafeLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  const [error, setError] = useState('');
  const url = externalHttpUrl(href);
  if (!url) return React.createElement(React.Fragment, null, children);
  return React.createElement(React.Fragment, null,
    React.createElement('a', {
      href: url,
      onClick: (event: MouseEvent<HTMLAnchorElement>) => followLink(event, url, (target) => {
        setError('');
        if (isTauri()) void invoke('browser_external', { url: target }).catch((reason) => setError(String(reason)));
        else window.open(target, '_blank', 'noopener,noreferrer');
      }),
    }, children),
    error && React.createElement('span', { role: 'alert' }, error),
  );
}

const safeComponents: Components = {
  a: SafeLink,
  img: ({ alt }) => React.createElement(React.Fragment, null, alt ?? ''),
};
const plugins = [remarkGfm, literalHtml];
export const MarkdownBody = memo(function MarkdownBody({ source, components }: { source: string; components?: Components }) {
  return React.createElement(ReactMarkdown, { remarkPlugins: plugins, components: { ...components, ...safeComponents }, children: source });
});
