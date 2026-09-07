const LOCAL_URL = 'https://roviq-local2.admytruk79.workers.dev';

export function LocalMap() {
  return (
    <section className="mt-8" aria-labelledby="partner-local-heading">
      <div className="panel overflow-hidden">
        <div className="flex flex-col justify-between gap-3 border-b border-white/10 p-5 sm:flex-row sm:items-center">
          <div>
            <p className="kicker">ROVIQ Local</p>
            <h2 id="partner-local-heading" className="mt-1 text-xl font-bold">Service movement map</h2>
            <p className="muted mt-1 max-w-2xl text-sm">Spatial context for inbound and outbound vehicle movement. Core remains authoritative for assignments and case status.</p>
          </div>
          <a className="secondary self-start text-sm" href={LOCAL_URL} target="_blank" rel="noreferrer">Open full map</a>
        </div>
        <div className="relative bg-[#08131f]">
          <iframe
            title="ROVIQ Local service movement map"
            src={LOCAL_URL}
            allow="geolocation"
            loading="lazy"
            className="partner-map-frame block w-full border-0"
          />
        </div>
      </div>
    </section>
  );
}
