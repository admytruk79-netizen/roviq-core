const LOCAL_MAP_URL = (import.meta.env.VITE_LOCAL_MAP_URL ?? 'https://roviq-local2.admytruk79.workers.dev').replace(/\/$/, '');

export function Local() {
  return (
    <section className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <span className="text-xs font-extrabold uppercase tracking-[0.18em] text-[var(--roviq-copper-soft)]">ROVIQ Local</span>
          <h1 className="mt-2 text-3xl font-bold text-white sm:text-4xl">Live local map</h1>
          <p className="mt-2 max-w-2xl text-sm text-[var(--roviq-muted)] sm:text-base">
            Use the shared ROVIQ map to understand your location, nearby places and the service journey around your vehicle.
          </p>
        </div>
        <a
          href={LOCAL_MAP_URL}
          target="_blank"
          rel="noreferrer"
          className="roviq-btn-secondary inline-flex items-center justify-center text-sm"
        >
          Open full map
        </a>
      </div>

      <div className="overflow-hidden rounded-2xl border border-white/10 bg-[var(--roviq-navy)] shadow-2xl">
        <iframe
          title="ROVIQ Local map"
          src={LOCAL_MAP_URL}
          className="h-[68vh] min-h-[520px] w-full border-0"
          allow="geolocation"
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </div>
    </section>
  );
}
