const LOCAL_URL = 'https://roviq-local2.admytruk79.workers.dev';

export function NetworkMap() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
        <div>
          <p className="roviq-kicker">Network oversight</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">ROVIQ Local operations map</h1>
          <p className="roviq-muted mt-2 max-w-3xl text-sm sm:text-base">Cross-network spatial oversight for active service activity, transport movement and service locations. ROVIQ Core remains authoritative for case state, assignments, exceptions and permissions.</p>
        </div>
        <a href={LOCAL_URL} target="_blank" rel="noreferrer" className="roviq-btn-secondary self-start text-sm">Open full map</a>
      </div>

      <section className="overflow-hidden rounded-2xl border border-white/10 bg-white/[.035] shadow-2xl">
        <div className="grid gap-3 border-b border-white/10 p-4 sm:grid-cols-3 sm:p-5">
          <div><p className="roviq-muted text-xs uppercase tracking-[.14em]">View</p><p className="mt-1 font-semibold">Network-wide</p></div>
          <div><p className="roviq-muted text-xs uppercase tracking-[.14em]">Operational source</p><p className="mt-1 font-semibold">ROVIQ Core</p></div>
          <div><p className="roviq-muted text-xs uppercase tracking-[.14em]">Spatial source</p><p className="mt-1 font-semibold">ROVIQ Local</p></div>
        </div>
        <iframe
          title="ROVIQ Local operations oversight map"
          src={LOCAL_URL}
          allow="geolocation"
          className="block h-[560px] w-full border-0 lg:h-[660px]"
        />
      </section>
    </div>
  );
}
