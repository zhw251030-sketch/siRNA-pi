// Independent implementation of the transparent_prefilter_v1 mathematical/output contract.
// Behavioral reference: ZhxinMath/sirna-pi-agent-service-refactor, application 965c53f,
// packages/domain/sirna-tools/candidates.ts (reference checkout 67d2754).
// No reference application source is copied; its application license is unspecified.

const rnaComplement = { A: 'U', T: 'A', C: 'G', G: 'C' };
const fourDecimals = (value) => Math.round(value * 10000) / 10000;

function normalizedSequence(input) {
  if (typeof input !== 'string' || input.length < 19 || input.length > 100000) {
    throw new Error('targetSequence must be a string with raw length from 19 to 100000');
  }
  // Match the reference's multi-record concatenation. Callers should supply one target record.
  const lines = input.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('>'));
  const dna = lines.join('').replace(/\s/g, '').toUpperCase().replace(/U/g, 'T');
  if (dna.length === 0) throw new Error('targetSequence contains no sequence bases');
  if (/[^ACGT]/.test(dna)) throw new Error('targetSequence may contain only A, C, G, T or U');
  return dna;
}

function candidateAt(dna, offset, length, minGc, maxGc) {
  const window = dna.slice(offset, offset + length);
  let guide = '';
  let gcCount = 0;
  let runLength = 0;
  let repeated = false;
  const bases = new Set();
  for (let index = 0; index < length; index += 1) {
    const base = window[index];
    guide = rnaComplement[base] + guide;
    bases.add(base);
    if (base === 'G' || base === 'C') gcCount += 1;
    runLength = index > 0 && base === window[index - 1] ? runLength + 1 : 1;
    if (runLength >= 4) repeated = true;
  }

  const fraction = gcCount / length;
  const warnings = [];
  let score = .7;
  if (fraction < minGc || fraction > maxGc) {
    const below = fraction < minGc;
    warnings.push(below ? 'gc_below_range' : 'gc_above_range');
    const distance = below ? minGc - fraction : fraction - maxGc;
    score -= Math.min(.4, 1.5 * distance);
  } else {
    const center = (minGc + maxGc) / 2;
    const radius = Math.max(.01, (maxGc - minGc) / 2);
    score += .15 * (1 - Math.abs(fraction - center) / radius);
  }
  if (repeated) {
    warnings.push('homopolymer_4_or_more');
    score -= .25;
  }
  if (bases.size < 3) {
    warnings.push('low_base_diversity');
    score -= .15;
  }
  if (guide[0] === 'A' || guide[0] === 'U') score += .08;
  if (guide[length - 1] === 'C' || guide[length - 1] === 'G') score += .04;

  return {
    id: `SIRNA-${String(offset + 1).padStart(5, '0')}`,
    start: offset + 1,
    end: offset + length,
    targetWindow: window.replace(/T/g, 'U'),
    guide,
    gcFraction: fourDecimals(fraction),
    prefilterScore: fourDecimals(Math.max(0, Math.min(1, score))),
    warnings,
  };
}

export function enumerateCandidates(targetSequence, options = {}) {
  const dna = normalizedSequence(targetSequence);
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('options must be an object');
  }
  const {
    guideLength = 21, minGc = .3, maxGc = .55, maxCandidates = 40,
  } = options;
  if (!Number.isInteger(guideLength) || guideLength < 19 || guideLength > 27) {
    throw new Error('guideLength must be an integer from 19 to 27');
  }
  if (dna.length < guideLength) {
    throw new Error(`targetSequence must contain at least ${guideLength} bases`);
  }
  if (!Number.isFinite(minGc) || !Number.isFinite(maxGc) || minGc < 0 || maxGc > 1 || minGc >= maxGc) {
    throw new Error('minGc and maxGc must be finite numbers satisfying 0 <= minGc < maxGc <= 1');
  }
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 500) {
    throw new Error('maxCandidates must be an integer from 1 to 500');
  }

  const totalWindows = dna.length - guideLength + 1;
  const ranked = [];
  for (let offset = 0; offset < totalWindows; offset += 1) {
    ranked.push(candidateAt(dna, offset, guideLength, minGc, maxGc));
  }
  ranked.sort((a, b) => {
    const scoreOrder = b.prefilterScore - a.prefilterScore;
    if (scoreOrder !== 0) return scoreOrder;
    const warningOrder = a.warnings.length - b.warnings.length;
    return warningOrder || a.start - b.start;
  });
  const candidates = ranked.slice(0, maxCandidates);
  return {
    sequenceLength: dna.length,
    guideLength,
    totalWindows,
    returnedCandidates: candidates.length,
    scoringMethod: 'transparent_prefilter_v1',
    candidates,
  };
}
