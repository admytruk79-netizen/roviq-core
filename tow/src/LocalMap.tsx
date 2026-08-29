import {useMemo} from 'react';

type Props={caseId?:string;dispatchId?:string;dispatchStatus?:string};

const LOCAL='https://roviq-local2.admytruk79.workers.dev/';

export function LocalMap({caseId,dispatchId,dispatchStatus}:Props){
  const src=useMemo(()=>{
    const q=new URLSearchParams();
    q.set('embed','1');
    q.set('mode','tow');
    if(caseId)q.set('caseId',caseId);
    if(dispatchId)q.set('dispatchId',dispatchId);
    if(dispatchStatus)q.set('dispatchStatus',dispatchStatus);
    return `${LOCAL}?${q.toString()}`;
  },[caseId,dispatchId,dispatchStatus]);

  return (
    <section className="map-panel dispatch-context live-local-map">
      <div className="map-head">
        <div>
          <span className="eyebrow map-eyebrow">ROVIQ Local · Tow</span>
          <h2>{dispatchId?'Live dispatch map':'Tow live map'}</h2>
          <p>{dispatchId?'Live ROVIQ Local navigation for the active dispatch.':'The live ROVIQ Local map stays available before a dispatch is assigned.'}</p>
        </div>
      </div>
      <div className="live-map-wrap live-map-embedded">
        <iframe
          key={src}
          className="live-map-frame"
          src={src}
          title="ROVIQ Local live tow map"
          allow="geolocation"
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </div>
    </section>
  );
}
