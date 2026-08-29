const LOCAL_URL='https://roviq-local2.admytruk79.workers.dev';

export function LocalMap(){return <section className="map-panel"><div className="map-head"><div><span className="eyebrow map-eyebrow">ROVIQ Local</span><h2>Dispatch map</h2><p>Use spatial context for pickup, destination and vehicle handoffs. Dispatch status remains controlled by ROVIQ Core.</p></div><a className="secondary" href={LOCAL_URL} target="_blank" rel="noreferrer">Open full map</a></div><iframe title="ROVIQ Local dispatch map" src={LOCAL_URL} allow="geolocation" /></section>}
