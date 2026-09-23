// Shared conversation session persistence for the Cloudflare gateway.

const WORKSPACES = new Set(['drive','customer','dispatcher','shop','tow','fleet','diagnostic','parts','admin']);
const SOURCES = new Set(['phone','android_auto','web','dispatcher','shop','tow','fleet','diagnostic','parts','admin']);

export function normalizeWorkspace(value, actorContext) {
  const requested = String(value || '').toLowerCase();
  if (WORKSPACES.has(requested)) return requested;
  if (actorContext?.role === 'admin') return 'admin';
  if (actorContext?.role === 'customer') return 'drive';
  return actorContext?.role || 'drive';
}

export async function loadOrCreateConversationSession(sql, actorContext, input = {}) {
  const requestedId = typeof input.sessionId === 'string' ? input.sessionId : null;
  if (requestedId) {
    const rows = await sql`
      select * from conversation_sessions
      where id=${requestedId}::uuid and state='active'
      limit 1
    `;
    const existing = rows[0];
    if (!existing) throw new Error('conversation_session_not_found');
    const owns = actorContext.role === 'admin'
      ? existing.principal_identity_id === actorContext.identityId
      : existing.actor_id === actorContext.actorId;
    if (!owns) throw new Error('conversation_session_forbidden');
    return existing;
  }

  const workspace = normalizeWorkspace(input.workspace, actorContext);
  const source = SOURCES.has(String(input.presentationSource || '')) ? String(input.presentationSource) : 'phone';
  const rows = await sql`
    insert into conversation_sessions(
      principal_identity_id,actor_id,organization_id,active_role,workspace,presentation_source
    ) values(
      ${actorContext.identityId || null}::uuid,
      ${actorContext.actorId || null}::uuid,
      ${actorContext.organizationId || null}::uuid,
      ${actorContext.role},
      ${workspace},
      ${source}
    )
    returning *
  `;
  return rows[0];
}

export async function updateConversationSession(sql, sessionId, patch = {}) {
  const rows = await sql`
    update conversation_sessions
    set
      vehicle_id=coalesce(${patch.vehicleId || null}::uuid,vehicle_id),
      service_case_id=coalesce(${patch.serviceCaseId || null}::uuid,service_case_id),
      journey_context=case when ${patch.journeyContext ? true : false} then ${JSON.stringify(patch.journeyContext || {})}::jsonb else journey_context end,
      last_intent=coalesce(${patch.intent || null},last_intent),
      last_entities=case when ${patch.entities ? true : false} then ${JSON.stringify(patch.entities || {})}::jsonb else last_entities end,
      last_result_refs=case when ${patch.resultRefs ? true : false} then ${JSON.stringify(patch.resultRefs || [])}::jsonb else last_result_refs end,
      updated_at=now(),
      last_message_at=now()
    where id=${sessionId}::uuid and state='active'
    returning *
  `;
  return rows[0] || null;
}

export async function appendConversationTurn(sql, sessionId, direction, data = {}) {
  const rows = await sql`
    insert into conversation_turns(session_id,direction,intent,content,tool_name,tool_result_ref,metadata)
    values(
      ${sessionId}::uuid,
      ${direction},
      ${data.intent || null},
      ${data.content || null},
      ${data.toolName || null},
      ${data.toolResultRef ? JSON.stringify(data.toolResultRef) : null}::jsonb,
      ${JSON.stringify(data.metadata || {})}::jsonb
    )
    returning id,created_at
  `;
  return rows[0];
}

export function sessionContext(session) {
  return {
    sessionId: session.id,
    workspace: session.workspace,
    activeRole: session.active_role,
    vehicleId: session.vehicle_id,
    serviceCaseId: session.service_case_id,
    journey: session.journey_context || {},
    lastIntent: session.last_intent,
    lastEntities: session.last_entities || {},
    lastResultRefs: session.last_result_refs || [],
    presentationSource: session.presentation_source
  };
}
