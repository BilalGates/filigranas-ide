// Monaco pesa: se carga la primera vez que se abre un archivo o un diff.
type MonacoModule = typeof import('./monaco');

let loading: Promise<MonacoModule> | null = null;
export const loadMonaco = () => (loading ??= import('./monaco'));

export const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
export const themeName = () => (darkQuery.matches ? 'filigranas-dark' : 'filigranas-light');
