import { Component, type ReactNode } from 'react';
import { Icon } from './icons';

/** Un fallo en un destino no tumba el resto de la app (ni el Workspace montado). */
export default class Boundary extends Component<{ name: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error(`[trama] ${this.props.name}:`, error); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className="tr-dest" aria-label={this.props.name}>
        <div className="tr-empty">
          <span className="art"><Icon name="warn" size={40} /></span>
          <h3>{this.props.name} ha fallado</h3>
          <p className="mono" style={{ fontSize: 12 }}>{this.state.error.message}</p>
          <button className="tr-btn" onClick={() => this.setState({ error: null })}>Reintentar</button>
        </div>
      </section>
    );
  }
}
