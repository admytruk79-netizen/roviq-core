export type ConnectHealth = 'healthy'|'attention'|'degraded'|'paused'|'failed'|'revoked'|'planned';
export type CredentialState = 'unknown'|'configured'|'valid'|'expiring'|'expired'|'revoked'|'error';
export type AccessState = 'unknown'|'authorized'|'limited'|'denied'|'revoked';
export type ConnectionStatus = 'planned'|'active'|'paused'|'degraded'|'revoked'|'failed';
export type FallbackMode = 'none'|'bridge'|'manual';

export function deriveConnectHealth(input:{
  connectionStatus:ConnectionStatus;
  credentialState:CredentialState;
  accessState:AccessState;
  lastSuccessAt?:string|Date|null;
  now?:Date;
  mode:'native_integration'|'roviq_native'|'bridge';
  fallbackEnabled?:boolean;
  fallbackMode?:FallbackMode;
}):{health:ConnectHealth;reasons:string[];fallbackActive:boolean}{
  const reasons:string[]=[];
  const fallbackActive=!!input.fallbackEnabled && input.fallbackMode !== 'none';
  if(input.connectionStatus==='revoked') return {health:'revoked',reasons:['connection_revoked'],fallbackActive:false};
  if(input.connectionStatus==='failed') return {health:'failed',reasons:['connection_failed'],fallbackActive};
  if(input.connectionStatus==='paused') return {health:'paused',reasons:['connection_paused'],fallbackActive};
  if(input.connectionStatus==='planned') return {health:'planned',reasons:['connection_planned'],fallbackActive:false};

  if(['expired','revoked','error'].includes(input.credentialState)) reasons.push(`credential_${input.credentialState}`);
  else if(['unknown','expiring'].includes(input.credentialState) && input.mode==='native_integration') reasons.push(`credential_${input.credentialState}`);

  if(['denied','revoked'].includes(input.accessState)) reasons.push(`access_${input.accessState}`);
  else if(['unknown','limited'].includes(input.accessState) && input.mode==='native_integration') reasons.push(`access_${input.accessState}`);

  if(input.mode==='native_integration') {
    if(!input.lastSuccessAt) reasons.push('sync_never_succeeded');
    else {
      const now=input.now ?? new Date();
      const age=now.getTime()-new Date(input.lastSuccessAt).getTime();
      if(!Number.isFinite(age) || age>60*60*1000) reasons.push('sync_degraded');
      else if(age>15*60*1000) reasons.push('sync_stale');
    }
  }

  if(input.connectionStatus==='degraded' || reasons.some((r)=>['credential_expired','credential_revoked','credential_error','access_denied','access_revoked','sync_degraded'].includes(r))) {
    return {health:'degraded',reasons,fallbackActive};
  }
  if(reasons.length) return {health:'attention',reasons,fallbackActive};
  return {health:'healthy',reasons:[],fallbackActive};
}
