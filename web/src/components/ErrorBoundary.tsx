import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { hasError: boolean };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('roviq_web_render_error', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="roviq-shell" style={{ display: 'grid', placeItems: 'center', padding: '24px', textAlign: 'center' }}>
          <div>
            <p className="roviq-kicker">Something went wrong</p>
            <h1 style={{ marginTop: 8 }}>This page hit an unexpected error.</h1>
            <p className="roviq-muted" style={{ marginTop: 8 }}>Reloading usually fixes this.</p>
            <button type="button" className="roviq-btn-primary" style={{ marginTop: 16 }} onClick={() => window.location.reload()}>Reload</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
