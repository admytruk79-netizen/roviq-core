import { Link } from 'react-router-dom';

export function NotFound() {
  return (
    <section className="roviq-panel roviq-empty-state">
      <p className="roviq-kicker">Page not found</p>
      <h2>We couldn't find that page.</h2>
      <p className="roviq-muted">It may have moved, or the link may be out of date.</p>
      <Link to="/" className="roviq-btn-primary">Back to my cases</Link>
    </section>
  );
}
