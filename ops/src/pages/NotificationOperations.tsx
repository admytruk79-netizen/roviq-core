import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { formatDateTime, humanizeToken } from '../lib/format';

type NotificationRow={
  id:string;
  case_id?:string|null;
  channel:string;
  template_key:string;
  state:string;
  attempt_count?:number|null;
  max_attempts?:number|null;
  provider?:string|null;
  provider_message_id?:string|null;
  last_error?:string|null;
  available_at?:string|null;
  sent_at?:string|null;
  created_at:string;
};

type ChannelConfig={channel:string;provider:string;enabled:boolean;updated_at:string};

export function NotificationOperations(){
  const [notifications,setNotifications]=useState<NotificationRow[]>([]);
  const [channels,setChannels]=useState<ChannelConfig[]>([]);
  const [loading,setLoading]=useState(true);
  const [processing,setProcessing]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [message,setMessage]=useState<string|null>(null);

  async function load(){
    setLoading(true);
    setError(null);
    try{
      const [outbox,channelResult]=await Promise.all([
        api.get<{notifications:NotificationRow[]}>('/api/admin/notifications/outbox?limit=200'),
        api.get<{channels:ChannelConfig[]}>('/api/admin/notifications/channels')
      ]);
      setNotifications(outbox.notifications);
      setChannels(channelResult.channels);
    }catch(err){
      setError(err instanceof Error?err.message:'Unable to load notification operations');
    }finally{
      setLoading(false);
    }
  }

  useEffect(()=>{ void load(); },[]);

  async function processQueue(){
    setProcessing(true);
    setMessage(null);
    setError(null);
    try{
      const result=await api.post<{processed:unknown[]}>('/api/admin/notifications/process',{workerId:'ops-console',limit:50});
      setMessage(`Processed ${result.processed.length} queued notification${result.processed.length===1?'':'s'}.`);
      await load();
    }catch(err){
      setError(err instanceof Error?err.message:'Unable to process notification queue');
    }finally{
      setProcessing(false);
    }
  }

  const counts=useMemo(()=>notifications.reduce<Record<string,number>>((acc,row)=>{
    acc[row.state]=(acc[row.state]??0)+1;
    return acc;
  },{}),[notifications]);

  const attention=notifications.filter(row=>row.state==='dead'||row.last_error);

  return <section className="space-y-5" aria-labelledby="notification-ops-title">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p className="text-xs font-bold uppercase tracking-[.14em] text-[var(--roviq-muted)]">Delivery truth</p>
        <h1 id="notification-ops-title" className="mt-1 text-2xl font-bold text-slate-950">Notifications</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-600">Queued, retrying, sent, and failed customer communications from the canonical notification outbox.</p>
      </div>
      <div className="flex gap-2">
        <button className="roviq-btn-secondary" onClick={()=>void load()} disabled={loading||processing}>Refresh</button>
        <button className="roviq-btn-primary" onClick={()=>void processQueue()} disabled={processing}>{processing?'Processing…':'Process queue'}</button>
      </div>
    </div>

    <div className="grid gap-3 sm:grid-cols-4">
      {[
        ['Pending',counts.pending??0],
        ['Sent',counts.sent??0],
        ['Dead',counts.dead??0],
        ['Needs attention',attention.length]
      ].map(([label,value])=><div key={String(label)} className="rounded-xl border border-slate-200 bg-white p-4"><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div><div className="mt-1 text-2xl font-bold text-slate-950">{value}</div></div>)}
    </div>

    {message&&<div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">{message}</div>}
    {error&&<div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"><div className="font-semibold">Notification operations need attention.</div><div className="mt-1">{error}</div></div>}

    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="font-semibold text-slate-950">Delivery channels</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {channels.length===0&&<p className="text-sm text-slate-600">No delivery channels are configured.</p>}
        {channels.map(channel=><div key={channel.channel} className="rounded-lg bg-slate-50 p-3 text-sm">
          <div className="flex items-center justify-between gap-2"><span className="font-semibold text-slate-900">{humanizeToken(channel.channel)}</span><span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${channel.enabled?'border-emerald-200 bg-emerald-50 text-emerald-800':'border-slate-200 bg-slate-100 text-slate-600'}`}>{channel.enabled?'Enabled':'Disabled'}</span></div>
          <div className="mt-2 text-slate-600">Provider: <span className="font-medium text-slate-900">{channel.provider}</span></div>
          <div className="mt-1 text-xs text-slate-500">Updated {formatDateTime(channel.updated_at)}</div>
        </div>)}
      </div>
    </div>

    <div className="rounded-xl border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 py-3"><h2 className="font-semibold text-slate-950">Recent delivery state</h2></div>
      {loading?<div className="p-5 text-sm text-slate-500" aria-live="polite">Loading notification delivery state…</div>:
      notifications.length===0?<div className="p-5 text-sm text-slate-600">No notifications are in the outbox.</div>:
      <div className="divide-y divide-slate-100">
        {notifications.map(row=><div key={row.id} className="grid gap-2 p-4 text-sm lg:grid-cols-[1.2fr_.7fr_.7fr_1fr]">
          <div className="min-w-0"><div className="truncate font-medium text-slate-950">{humanizeToken(row.template_key)}</div><div className="mt-1 text-xs text-slate-500">{row.channel} · {formatDateTime(row.created_at)}</div></div>
          <div><span className="text-xs uppercase tracking-wide text-slate-500">State</span><div className="mt-1 font-medium text-slate-900">{humanizeToken(row.state)}</div></div>
          <div><span className="text-xs uppercase tracking-wide text-slate-500">Attempts</span><div className="mt-1 font-medium text-slate-900">{Number(row.attempt_count??0)} / {Number(row.max_attempts??5)}</div></div>
          <div><span className="text-xs uppercase tracking-wide text-slate-500">Provider</span><div className="mt-1 break-words font-medium text-slate-900">{row.provider??'Not assigned'}</div>{row.last_error&&<div className="mt-1 text-xs text-rose-700">{row.last_error}</div>}</div>
        </div>)}
      </div>}
    </div>
  </section>;
}
