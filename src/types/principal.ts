export type RoviqRole = 'admin' | 'customer' | 'partner' | 'diagnostic' | 'tow' | 'parts' | 'fleet';

export interface Principal {
  role: RoviqRole;
  actorId?: string;
}
