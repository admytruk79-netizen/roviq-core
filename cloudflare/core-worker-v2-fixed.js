import { Client } from 'pg';
import worker from './core-worker-v2.js';

// Compatibility guard for the v2 routing query. PostgreSQL requires every
// ORDER BY expression used with SELECT DISTINCT to be present in the select
// list. Keep the authoritative v2 worker intact while correcting that query
// before it reaches Neon through Hyperdrive.
const originalQuery = Client.prototype.query;

Client.prototype.query = function patchedQuery(text, ...args) {
  if (
    typeof text === 'string' &&
    text.includes('select distinct a.id,a.actor_type,') &&
    text.includes('order by pc.earliest_available_at asc nulls last,a.created_at asc') &&
    !text.includes('a.created_at,\n              coalesce(pc.routing_enabled,true)')
  ) {
    text = text.replace(
      'select distinct a.id,a.actor_type,\n              coalesce(pc.routing_enabled,true)',
      'select distinct a.id,a.actor_type,a.created_at,\n              coalesce(pc.routing_enabled,true)'
    );
  }
  return originalQuery.call(this, text, ...args);
};

export default worker;
