const portals = [
  {
    name: 'Customer',
    label: 'Driver / Vehicle owner',
    description: 'Create and follow service cases, approvals, handoffs and status.',
    href: 'https://roviq-web-dxv.pages.dev'
  },
  {
    name: 'Diagnostic',
    label: 'Diagnostic network',
    description: 'Review diagnostic work, findings and case-level diagnostic activity.',
    href: 'https://roviq-diagnostic-net.pages.dev'
  },
  {
    name: 'Partner',
    label: 'Shop / Dealership',
    description: 'Receive coordinated work, manage capacity and accept routed cases.',
    href: 'https://roviq-partner.pages.dev'
  },
  {
    name: 'Parts',
    label: 'Parts vendor',
    description: 'Handle parts demand, availability and fulfillment linked to ROVIQ cases.',
    href: 'https://roviq-parts-net.pages.dev'
  },
  {
    name: 'Tow / Valet',
    label: 'Vehicle movement',
    description: 'Receive dispatches and update pickup, transit, arrival and delivery states.',
    href: 'https://roviq-tow-net.pages.dev'
  },
  {
    name: 'Ops / Oversight',
    label: 'ROVIQ operations',
    description: 'Cross-network oversight for cases, exceptions, assignments and the live map.',
    href: 'https://roviq-ops.pages.dev'
  }
];

export function Portals() {
  return (
    <div className="roviq-shell roviq-grid-glow min-h-screen px-5 py-8 sm:px-8 sm:py-12">
      <main className="mx-auto max-w-6xl">
        <div className="mb-9 flex flex-col justify-between gap-5 md:flex-row md:items-end">
          <div>
            <div className="roviq-brand mb-7"><span className="roviq-mark"><span>R</span></span><span>ROVIQ</span></div>
            <p className="roviq-kicker">ROVIQ network</p>
            <h1 className="mt-2 text-4xl font-black tracking-[-0.035em] sm:text-5xl">All portals. One Core.</h1>
            <p className="roviq-muted mt-3 max-w-2xl text-base leading-7">Choose the operating surface you need. Each portal connects to the same coordinated ROVIQ backend and case lifecycle.</p>
          </div>
        </div>

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {portals.map((portal) => (
            <a
              key={portal.name}
              href={portal.href}
              className="roviq-panel group flex min-h-[220px] flex-col justify-between p-6 transition hover:-translate-y-0.5 hover:border-[rgba(240,131,75,.45)]"
            >
              <div>
                <p className="roviq-kicker">{portal.label}</p>
                <h2 className="mt-3 text-2xl font-bold tracking-tight">{portal.name}</h2>
                <p className="roviq-muted mt-3 text-sm leading-6">{portal.description}</p>
              </div>
              <div className="mt-7 flex items-center justify-between text-sm font-bold text-[var(--roviq-copper-soft)]">
                <span>Open portal</span><span aria-hidden="true" className="transition group-hover:translate-x-1">→</span>
              </div>
            </a>
          ))}
        </section>

        <p className="roviq-muted mt-8 text-center text-xs">Multiple front ends. One coordinated backend. One ROVIQ engine.</p>
      </main>
    </div>
  );
}
