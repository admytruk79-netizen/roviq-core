type Props={caseId?:string;dispatchId?:string;dispatchStatus?:string};
const LOCAL_MAP_URL=(import.meta.env.VITE_LOCAL_MAP_URL??'https://roviq-local2.admytruk79.workers.dev').replace(/\/$/,'');

export function LocalMap({dispatchId,dispatchStatus}:Props){
  return <section className="map-panel dispatch-context">
    <div className="map-head"><div><span className="eyebrow map-eyebrow">ROVIQ Local</span><h2>Live local map</h2><p>{dispatchId?`Dispatch ${dispatchId.slice(0,8)}`:'Active dispatch'}{dispatchStatus?` · ${dispatchStatus.replaceAll('_',' ')}`:''}</p></div></div>
    <div className="live-map-wrap">
      <iframe className="live-map-frame" src={LOCAL_MAP_URL} title="ROVIQ Local map" allow="geolocation" referrerPolicy="strict-origin-when-cross-origin" />
    </div>
  </section>
}
