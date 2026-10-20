// Tool/output contract informed by sirna-pi-agent-service-refactor 965c53f,
// packages/domain/sirna-tools/sirna-tools.ts. Independently authored for this project:
// manual JSON Schema, strict argument validation, and one deterministic tool only.
import { enumerateCandidates } from './candidates.mjs';

export function validateCandidateArguments(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('Tool arguments must be an object');
  }
  for (const key of Object.keys(args)) {
    if (!['targetSequence', 'guideLength', 'maxCandidates'].includes(key)) {
      throw new Error(`Unknown argument: ${key}`);
    }
  }
  if (typeof args.targetSequence !== 'string' || args.targetSequence.length < 19 || args.targetSequence.length > 100000) {
    throw new Error('targetSequence must be a string with raw length from 19 to 100000');
  }
  if (args.guideLength !== undefined && (!Number.isInteger(args.guideLength) || args.guideLength < 19 || args.guideLength > 27)) {
    throw new Error('guideLength must be an integer from 19 to 27');
  }
  if (args.maxCandidates !== undefined && (!Number.isInteger(args.maxCandidates) || args.maxCandidates < 1 || args.maxCandidates > 100)) {
    throw new Error('maxCandidates must be an integer from 1 to 100');
  }
}

export function createSirnaTools() {
  return [{
    name: 'enumerate_sirna_candidates',
    label: 'Enumerate siRNA candidates',
    description: 'Enumerate antisense RNA guides using deterministic transparent_prefilter_v1 scores. '
      + 'The score is a prefilter, not an activity prediction. Supply a single target sequence or FASTA record; '
      + 'multiple FASTA records are concatenated, so windows can cross record boundaries.',
    parameters: {
      type: 'object',
      properties: {
        targetSequence: { type: 'string', minLength: 19, maxLength: 100000 },
        guideLength: { type: 'integer', minimum: 19, maximum: 27, default: 21 },
        maxCandidates: { type: 'integer', minimum: 1, maximum: 100, default: 40 },
      },
      required: ['targetSequence'],
      additionalProperties: false,
    },
    executionMode: 'sequential',
    execute: async (_toolCallId, args) => {
      validateCandidateArguments(args);
      const result = enumerateCandidates(args.targetSequence, {
        guideLength: args.guideLength,
        maxCandidates: args.maxCandidates,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  }];
}
