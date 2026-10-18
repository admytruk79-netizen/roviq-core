import type {Scan, ScanContext} from './obd-scan.js';
export const scanOutbox: {
  save(token:string,context:ScanContext,scan:Scan):Promise<void>;
  restore(token:string,caseId:string):Promise<{context:ScanContext;scan:Scan}|null>;
  remove(token:string,scanId:string):Promise<void>;
};
