import { describe,expect,it } from 'vitest';
import { deriveConnectHealth } from './connect-health.js';

describe('ROVIQ Connect operational health',()=>{
  it('reports a current authorized native integration as healthy',()=>{
    const now=new Date('2026-09-05T02:00:00Z');
    expect(deriveConnectHealth({
      connectionStatus:'active',credentialState:'valid',accessState:'authorized',
      lastSuccessAt:'2026-09-05T01:55:00Z',now,mode:'native_integration'
    })).toEqual({health:'healthy',reasons:[],fallbackActive:false});
  });

  it('flags stale native integration without promoting it to failed',()=>{
    const now=new Date('2026-09-05T02:00:00Z');
    const result=deriveConnectHealth({
      connectionStatus:'active',credentialState:'valid',accessState:'authorized',
      lastSuccessAt:'2026-09-05T01:30:00Z',now,mode:'native_integration'
    });
    expect(result.health).toBe('attention');
    expect(result.reasons).toContain('sync_stale');
  });

  it('degrades expired credentials and exposes Bridge fallback',()=>{
    const result=deriveConnectHealth({
      connectionStatus:'degraded',credentialState:'expired',accessState:'authorized',
      lastSuccessAt:null,mode:'native_integration',fallbackEnabled:true,fallbackMode:'bridge'
    });
    expect(result.health).toBe('degraded');
    expect(result.reasons).toContain('credential_expired');
    expect(result.fallbackActive).toBe(true);
  });

  it('keeps revoked connections terminal and disables fallback',()=>{
    const result=deriveConnectHealth({
      connectionStatus:'revoked',credentialState:'revoked',accessState:'revoked',
      lastSuccessAt:null,mode:'native_integration',fallbackEnabled:true,fallbackMode:'manual'
    });
    expect(result).toEqual({health:'revoked',reasons:['connection_revoked'],fallbackActive:false});
  });

  it('does not require external credentials for ROVIQ-native Shop OS',()=>{
    const result=deriveConnectHealth({
      connectionStatus:'active',credentialState:'unknown',accessState:'unknown',
      lastSuccessAt:null,mode:'roviq_native'
    });
    expect(result).toEqual({health:'healthy',reasons:[],fallbackActive:false});
  });
});
