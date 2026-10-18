import {createHealthEvent} from './obd-scan.js';
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
function owner(token) {
  try {
    const encoded = token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
    const claims = JSON.parse(atob(encoded));
    if (typeof claims.sub === 'string' && /^[0-9a-f-]{36}$/i.test(claims.sub)) return claims.sub;
  } catch {}
  throw new Error('scan_account_required');
}
export function createScanOutbox(store, now = Date.now) {
  return {
    async save(token, context, scan) {
      createHealthEvent(context,scan);
      const account = owner(token), key = `${account}:${scan.scanId}`;
      const rows = await store.list();
      for (const row of rows) if(now()-row.savedAt>MAX_AGE) await store.remove(row.key);
      const active = rows.filter(row=>now()-row.savedAt<=MAX_AGE);
      if(!active.some(row=>row.key===key)&&active.length>=10) throw new Error('scan_outbox_full');
      await store.put({key,account,context,scan,savedAt:now()});
    },
    async restore(token,caseId) {
      const account = owner(token), rows = await store.list();
      return rows.filter(row=>row.account===account&&row.context.serviceCaseId===caseId&&now()-row.savedAt<=MAX_AGE)
        .sort((a,b)=>b.savedAt-a.savedAt)[0]??null;
    },
    async remove(token,scanId) {await store.remove(`${owner(token)}:${scanId}`);}
  };
}

function databaseStore() {
  async function operation(mode, action) {
    if (!globalThis.indexedDB) throw new Error('scan_storage_unavailable');
    const db = await new Promise((resolve,reject)=>{
      const request=indexedDB.open('roviq-obd-pending',1);
      request.onupgradeneeded=()=>{request.result.createObjectStore('scans',{keyPath:'key'});};
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
    });
    return new Promise((resolve,reject)=>{
      const transaction=db.transaction('scans',mode), request=action(transaction.objectStore('scans'));
      let result;
      request.onsuccess=()=>{result=request.result;};
      transaction.oncomplete=()=>{db.close();resolve(result);};
      transaction.onerror=transaction.onabort=()=>{db.close();reject(transaction.error??new Error('scan_storage_failed'));};
    });
  }
  return {list:()=>operation('readonly',store=>store.getAll()),put:row=>operation('readwrite',store=>store.put(row)),remove:key=>operation('readwrite',store=>store.delete(key))};
}
export const scanOutbox=createScanOutbox(databaseStore());
