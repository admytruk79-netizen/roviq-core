alter table webhook_deliveries add column if not exists locked_at timestamptz;
create index if not exists webhook_deliveries_processing_idx on webhook_deliveries(state,locked_at) where state='processing';
