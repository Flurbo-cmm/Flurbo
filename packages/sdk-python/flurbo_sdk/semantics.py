"""Fresh, deployment-bound pre-sign semantic assessments. Unknown combinations abstain."""
import re


def semantic_error(r, deployment, claim, quantity, now):
    try:
        if type(deployment['eventCount']) is not int or not 2 <= deployment['eventCount'] <= 4:
            return 'SEMANTICS_UNAVAILABLE'
        if (r['schema'] != 'flurbo.semantic-assessment.v1' or r['pool'] != deployment['pool'] or r['rulesHash'] != deployment['rulesHash']
                or r['scope'] != claim['scope'] or r['mask'] != str(claim['mask']) or r['quantityAtoms'] != str(quantity)
                or type(r['checkedAt']) is not int or type(r['expiresAt']) is not int or r['checkedAt'] > now + 15 or r['expiresAt'] <= now or r['expiresAt'] - r['checkedAt'] != 60
                or type(r['configRevision']) is not str or not re.fullmatch('[0-9a-f]{64}', r['configRevision'])):
            return 'SEMANTICS_UNAVAILABLE'
        # A valid, claim-bound "disabled" answer proceeds without semantic assurance; anything else that is not "enforced" is unavailable.
        if r['mode'] == 'disabled':
            return None
        if (r['mode'] != 'enforced' or type(r['rulesDigest']) is not str
                or not re.fullmatch('[0-9a-f]{64}', r['rulesDigest']) or r['status'] not in ('collision', 'unknown', 'no_declared_collision')
                or r['coverage'] not in ('unknown', 'partial', 'complete') or len(r['matrix']) != 2 ** deployment['eventCount']):
            return 'SEMANTICS_UNAVAILABLE'
        events = [i for i in range(deployment['eventCount']) if claim['scope'] & (1 << i)]
        for state, row in enumerate(r['matrix']):
            local = sum(1 << j for j, event in enumerate(events) if state & (1 << event))
            if row['state'] != state or type(row['admissible']) is not bool or type(row['pays']) is not bool or row['pays'] != bool(int(claim['mask']) & (1 << local)):
                return 'SEMANTICS_UNAVAILABLE'
        if not any(row['admissible'] for row in r['matrix']):
            return 'SEMANTICS_UNAVAILABLE'
        collision = not any(row['admissible'] and row['pays'] for row in r['matrix'])
        if collision != (r['status'] == 'collision'):
            return 'SEMANTICS_UNAVAILABLE'
        if collision:
            return 'SEMANTIC_COLLISION'
        if len(events) > 1 and (r['coverage'] != 'complete' or r['status'] == 'unknown'):
            return 'SEMANTICS_UNKNOWN'
        return None
    except (KeyError, TypeError, ValueError, OverflowError):
        return 'SEMANTICS_UNAVAILABLE'


def semantics_disabled(r):
    """Only meaningful after semantic_error returned None: checks are switched off, so nothing was verified."""
    return isinstance(r, dict) and r.get('mode') == 'disabled'
