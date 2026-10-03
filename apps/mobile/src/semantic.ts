import { semanticAcknowledgment, type PilotNamespace, type PilotReview } from '../../web/src/pilot.ts';

// Mobile shares the web submission path, so it must pass its own market and the reviewed acknowledgment.
// Without the namespace, a practice purchase would be checked against the real-event pilot and refused.
export type SemanticConsent = { review: PilotReview | null; phrase: string };
export const semanticCollision = (review: PilotReview | null) => review?.requested.action === 'buy' && review.semanticAssessment?.mode === 'enforced' && review.semanticAssessment.status === 'collision';
export const semanticReady = (review: PilotReview | null, consent: SemanticConsent) =>
  !semanticCollision(review) || consent.review === review && consent.phrase === semanticAcknowledgment;
export function submitOptions(review: PilotReview, namespace: PilotNamespace, consent: SemanticConsent) {
  return { namespace, acknowledgment: { rulesDigest: review.semanticAssessment?.rulesDigest ?? '', phrase: consent.review === review ? consent.phrase : '' } };
}
