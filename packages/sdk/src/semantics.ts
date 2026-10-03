// Validate a fresh, claim-bound backend assessment. Never treat a missing check as success.
export type SemanticExpectation = { pool: string; rulesHash: string; eventCount: number; scope: number; mask: string; quantityAtoms: string };
// A valid, claim-bound "disabled" answer proceeds without semantic assurance. A failed request, a stale
// or malformed answer, or any other mode is SEMANTICS_UNAVAILABLE, never "disabled".
export function semanticError(r: any, e: SemanticExpectation, now: number, requireCoverage = true): string | null {
  if(!Number.isInteger(e.eventCount)||e.eventCount<2||e.eventCount>4)return 'SEMANTICS_UNAVAILABLE';
  if (!r || r.schema !== 'flurbo.semantic-assessment.v1' || r.pool !== e.pool || r.rulesHash !== e.rulesHash || r.scope !== e.scope || r.mask !== e.mask || r.quantityAtoms !== e.quantityAtoms
    || !Number.isSafeInteger(r.checkedAt) || !Number.isSafeInteger(r.expiresAt) || r.checkedAt > now + 15 || r.expiresAt <= now || r.expiresAt - r.checkedAt !== 60
    || typeof r.configRevision !== 'string' || !/^[0-9a-f]{64}$/.test(r.configRevision)) return 'SEMANTICS_UNAVAILABLE';
  if (r.mode === 'disabled') return null;
  if (r.mode !== 'enforced' || !/^[0-9a-f]{64}$/.test(r.rulesDigest) || !['collision','unknown','no_declared_collision'].includes(r.status)
    || !['unknown','partial','complete'].includes(r.coverage) || !Array.isArray(r.matrix) || r.matrix.length !== 2 ** e.eventCount) return 'SEMANTICS_UNAVAILABLE';
  const events = Array.from({length:e.eventCount},(_,i)=>i).filter(i=>e.scope & (1<<i));
  if (r.matrix.some((row:any,state:number)=>{
    const local=events.reduce((v,event,i)=>v|(state&(1<<event)?1<<i:0),0);
    return !row||row.state!==state||typeof row.admissible!=='boolean'||row.pays!==Boolean(BigInt(e.mask)&(1n<<BigInt(local)));
  }) || !r.matrix.some((row:any)=>row.admissible)) return 'SEMANTICS_UNAVAILABLE';
  const collision = !r.matrix.some((row:any)=>row.admissible&&row.pays);
  if (collision !== (r.status === 'collision')) return 'SEMANTICS_UNAVAILABLE';
  if (collision) return 'SEMANTIC_COLLISION';
  if (requireCoverage && events.length > 1 && (r.coverage !== 'complete' || r.status === 'unknown')) return 'SEMANTICS_UNKNOWN';
  return null;
}
// Only meaningful after semanticError returned null: the operator switched checks off, so nothing was verified.
export const semanticsDisabled = (r: any) => r?.mode === 'disabled';
