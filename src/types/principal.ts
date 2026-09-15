export type RoviqRole = 'admin' | 'customer' | 'partner' | 'diagnostic' | 'tow' | 'parts' | 'fleet';

export interface Principal {
  role: RoviqRole;
  actorId?: string;
  /** The signed-in identity (principal_identities.id) behind this request, when one exists --
   *  distinct from actorId, and the only way to attribute an admin action to a specific admin,
   *  since every admin identity has actorId=null by design. */
  identityId?: string;
}
