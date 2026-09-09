//@ts-check
import { JarenValidator } from '@jarenjs/validate';
import { checkOutcome } from './check.js';
import { CLAIM_EVIDENCE_SCHEMA } from './schemas/evidence.js';
import { createGuardedRefiner } from './guarded.js';
const check = new JarenValidator({ collectErrors: true, skipErrors: false }).compile(CLAIM_EVIDENCE_SCHEMA);

/**
 * Validate structure and references, without interpreting prose or making requests.
 * Supplied artifacts are the host's allow-list; matching ids must retain their
 * admitted descriptor. Without an external list, the envelope is self-contained.
 * @param {any} envelope
 * @param {{ artifacts?: import('./schemas/evidence.js').ArtifactRecord[] }} [options]
 */
export function validateClaimEvidence(envelope, options = {}) {
  const shape = checkOutcome(check(envelope));
  if (!shape.valid) return shape;
  const errors = [];
  const add = (code, docPath, message) => errors.push({ code, docPath, instancePath: docPath, message });
  const sets = {};
  for (const kind of ['artifacts', 'evidence', 'claims']) {
    const ids = new Set();
    envelope[kind].forEach((record, index) => {
      if (ids.has(record.id)) add('EVIDENCE_DUPLICATE', `/${kind}/${index}/id`, `duplicate ${kind} id '${record.id}'`);
      ids.add(record.id);
    });
    sets[kind] = ids;
  }
  if (options.artifacts) {
    const admitted = new Map(options.artifacts.map((artifact) => [artifact.id, artifact]));
    envelope.artifacts.forEach((artifact, i) => {
      const held = admitted.get(artifact.id);
      if (!held || ['kind', 'locator', 'digest'].some((field) => artifact[field] !== held[field]))
        add('EVIDENCE_UNADMITTED', `/artifacts/${i}`, `artifact '${artifact.id}' is not admitted with this descriptor`);
    });
  }
  envelope.evidence.forEach((record, i) => {
    if (!sets.artifacts.has(record.artifact))
      add('EVIDENCE_ARTIFACT', `/evidence/${i}/artifact`, `unknown artifact '${record.artifact}'`);
  });
  const visible = new Set(envelope.visibleEvidence);
  envelope.visibleEvidence.forEach((id, i) => {
    if (!sets.evidence.has(id)) add('EVIDENCE_REFERENCE', `/visibleEvidence/${i}`, `unknown evidence '${id}'`);
  });
  envelope.claims.forEach((claim, i) => {
    if (claim.critical && (claim.status === 'unresolved' || claim.evidence.length === 0))
      add('EVIDENCE_CRITICAL', `/claims/${i}/status`, `critical claim '${claim.id}' is unresolved`);
    claim.evidence.forEach((id, j) => {
      if (!sets.evidence.has(id)) add('EVIDENCE_REFERENCE', `/claims/${i}/evidence/${j}`, `unknown evidence '${id}'`);
      else if (!visible.has(id)) add('EVIDENCE_HIDDEN', `/claims/${i}/evidence/${j}`, `evidence '${id}' is outside the visible view`);
    });
  });
  errors.sort((a, b) => a.docPath < b.docPath ? -1 : a.docPath > b.docPath ? 1 : a.code.localeCompare(b.code));
  return { valid: errors.length === 0, errors };
}

/**
 * A second guarded-document consumer: replace or patch a claim envelope using
 * host persistence and an explicit artifact admission list.
 * @param {{ read: () => Promise<any>, apply: (document: any, proposal: any) => any,
 *   validateProposal: (proposal: any) => any, commit: (document: any) => Promise<any>,
 *   artifacts: import('./schemas/evidence.js').ArtifactRecord[],
 *   snapshot?: () => Promise<any>, restore?: (token: any) => Promise<any> }} options
 */
export function createClaimRefiner(options) {
  const artifacts = JSON.parse(JSON.stringify(options.artifacts));
  return createGuardedRefiner({ ...options,
    validateCandidate: (next) => validateClaimEvidence(next, { artifacts }),
    planCommit: (next) => next,
  });
}
