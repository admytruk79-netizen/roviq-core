import { useState, type FormEvent } from 'react';

const API = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
export function RegisterShop({ onBack, onCreated }: { onBack: () => void; onCreated: (email: string) => void }) {
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [draft, setDraft] = useState({ businessName:'', operatorName:'', email:'', password:'', name:'', address:'', city:'', region:'', countryCode:'' });
  function change(key: keyof typeof draft, value: string) {
    setDraft(previous => ({ ...previous, [key]:value }));
    // Edits represent a new request; unchanged retries retain the key after a lost response.
    setRequestId(crypto.randomUUID());
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError('');
    const { name, address, city, region, countryCode, ...account } = draft;
    try {
      const response = await fetch(`${API}/api/shops/register`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({requestId,...account,location:{name,address,city,region,countryCode}}) });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        if (response.status===429) throw new Error('Too many setup attempts. Please try again later.');
        if (result.error==='onboarding_identity_or_request_exists') throw new Error('This email is already registered. Sign in with your existing account.');
        if (result.error==='onboarding_retry_conflict') throw new Error('These setup details have changed. Check them and try again.');
        throw new Error('Shop setup could not be completed. Check your details and try again.');
      }
      onCreated(draft.email.trim());
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to connect. Retry with the same details.'); }
    finally { setBusy(false); }
  }
  const fields: {key:keyof typeof draft;label:string;max:number;min?:number;type?:string;complete?:string}[] = [
    {key:'businessName',label:'Shop name',max:120,min:2,complete:'organization'},
    {key:'operatorName',label:'Your name',max:100,min:2,complete:'name'},
    {key:'email',label:'Sign-in email',max:254,type:'email',complete:'email'},
    {key:'password',label:'Password (12–128 characters)',min:12,max:128,type:showPassword?'text':'password',complete:'new-password'},
    {key:'name',label:'Location name',max:120,min:2},
    {key:'address',label:'Street address',max:300,min:3,complete:'street-address'},
    {key:'city',label:'City',max:100,min:2,complete:'address-level2'},
    {key:'region',label:'State / province / region',max:100,min:2,complete:'address-level1'},
    {key:'countryCode',label:'Two-letter country code (for example US or CA)',min:2,max:2,complete:'country'}
  ];
  return <form className="signin-card" onSubmit={submit} aria-busy={busy}>
    <h1>Create your shop</h1>
    <p className="hint">Set up your own shop workspace. No existing shop software is required.</p>
    <p className="hint">Network referrals and restricted services require separate configuration and credential review.</p>
    <fieldset disabled={busy} style={{border:0,padding:0,margin:0,minWidth:0}}>
      <legend className="hint">Shop and owner details</legend>
      {fields.map(field=><label key={field.key}>{field.label}<input name={field.key} type={field.type??'text'} required minLength={field.min} maxLength={field.max} autoComplete={field.complete} value={draft[field.key]} onChange={event=>change(field.key,event.target.value)} pattern={field.key==='countryCode'?'[A-Za-z]{2}':undefined}/></label>)}
      <button type="button" className="password-toggle" onClick={()=>setShowPassword(value=>!value)} aria-pressed={showPassword}>{showPassword?'Hide password':'Show password'}</button>
      {error&&<p className="error" role="alert">{error}</p>}
      <button className="primary" type="submit">{busy?'Creating shop…':'Create shop workspace'}</button>
      <button type="button" onClick={onBack}>Already have an account? Sign in</button>
    </fieldset>
  </form>;
}
