import { useMemo } from 'react';

const LOCAL='https://roviq-local2.admytruk79.workers.dev/';

type Props={caseId?:string;dispatchId?:string;dispatchStatus?:string};

export function LocalMap({caseId,dispatchId,dispatchStatus}:Props){
  const src=useMemo(()=>{
    const q=new URLSearchParams();
    q.set('mode','tow');
    if(caseId)q.set('caseId',caseId);
    if(dispatchId)q.set('dispatchId',dispatchId);
    if(dispatchStatus)q.set('dispatchStatus',dispatchStatus);
    return `${LOCAL}?${q.toString()}`;
  },[caseId,dispatchId,dispatchStatus]);

  return <section className="map-panel dispatch-context live-local-map"><div className="live-map-wrap"><iframe key={src} className="live-map-frame" src={src} title="ROVIQ Local live map" allow="geolocation" referrerPolicy="no-referrer"/></div></section>;
}
