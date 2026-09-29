import { Link } from 'react-router-dom';
import { Inventory } from './Inventory';

export function UkraineInventory() {
  return (
    <div className="roviq-shell min-h-screen">
      <header className="roviq-header">
        <div className="roviq-header-inner mx-auto max-w-6xl px-4 sm:px-6">
          <Link to="/ukraine" className="roviq-brand" aria-label="ROVIQ vehicle export">
            <span className="roviq-mark"><span>R</span></span>
            <span>ROVIQ Vehicle Export</span>
          </Link>
          <div className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--roviq-muted)]">U.S. trucks for Ukraine</div>
        </div>
      </header>
      <main className="roviq-grid-glow mx-auto min-h-[calc(100vh-65px)] max-w-6xl px-4 py-5 sm:px-6 sm:py-9">
        <Inventory />
      </main>
      <footer className="mx-auto max-w-6xl px-4 pb-8 text-xs text-[var(--roviq-muted)] sm:px-6">
        ROVIQ verifies live dealer availability, used status, mileage and export details before commitment.
      </footer>
    </div>
  );
}
