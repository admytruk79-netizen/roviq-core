const LOCAL_URL = 'https://roviq-local2.admytruk79.workers.dev';

export function LocalMap() {
  return (
    <section className="mx-auto max-w-7xl px-4 pb-8 sm:px-6">
      <div className="panel overflow-hidden">
        <div className="flex flex-col justify-between gap-3 border-b border-white/10 p-5 sm:flex-row sm:items-center">
          <div>
            <p className="kicker">ROVIQ Local</p>
            <h2 className="mt-1 text-xl font-bold">Service movement map</h2>
            <p className="muted mt-1 text-sm">Spatial context for inbound and outbound vehicle movement. Core remains authoritative for case assignments and status.</p>
          </div>
          <a className="secondary self-start text-sm" href={LOCAL_URL} target="_blank" rel="noreferrer">Open full map</a>
        </div>
        <iframe
          title="ROVIQ Local service movement map"
          src={LOCAL_URL}
          allow="geolocation"
          className="block h-[420px] w-full border-0 sm:h-[520px]"
        />
      </div>
    </section>
  );
}
