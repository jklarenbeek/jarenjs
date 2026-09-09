//@ts-check
const ID = { type: 'string', minLength: 1 };
const record = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });

/** An admitted artifact describes identity and location; validation never fetches it. */
export const ARTIFACT_SCHEMA = record({ id: ID, kind: ID, locator: ID, digest: ID,
  metadata: { type: 'object' } }, ['id', 'kind']);
/** Evidence selects content from one admitted artifact. */
export const EVIDENCE_SCHEMA = record({ id: ID, artifact: ID, selector: ID, quote: ID }, ['id', 'artifact']);
/** Status is an explicit author assertion, not an entailment or authority score. */
export const CLAIM_SCHEMA = record({ id: ID, text: ID, critical: { type: 'boolean' },
  status: { enum: ['supported', 'unresolved'] },
  evidence: { type: 'array', items: ID, uniqueItems: true } }, ['id', 'text', 'critical', 'status', 'evidence']);
/** Versioned referential envelope; visible ids are the evidence admitted to this view. */
export const CLAIM_EVIDENCE_SCHEMA = {
  ...record({ version: { const: 1 }, artifacts: { type: 'array', items: ARTIFACT_SCHEMA },
    evidence: { type: 'array', items: EVIDENCE_SCHEMA }, claims: { type: 'array', items: CLAIM_SCHEMA },
    visibleEvidence: { type: 'array', items: ID, uniqueItems: true } },
  ['version', 'artifacts', 'evidence', 'claims', 'visibleEvidence']),
};

/**
 * @typedef {{ id: string, kind: string, locator?: string, digest?: string, metadata?: Record<string, any> }} ArtifactRecord
 * @typedef {{ id: string, artifact: string, selector?: string, quote?: string }} EvidenceRecord
 * @typedef {{ id: string, text: string, critical: boolean, status: 'supported'|'unresolved', evidence: string[] }} ClaimRecord
 * @typedef {{ version: 1, artifacts: ArtifactRecord[], evidence: EvidenceRecord[], claims: ClaimRecord[], visibleEvidence: string[] }} ClaimEvidenceEnvelope
 */
