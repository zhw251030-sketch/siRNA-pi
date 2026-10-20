import test from 'node:test';
import assert from 'node:assert/strict';
import { enumerateCandidates } from '../packages/domain/sirna-tools/candidates.mjs';
import { createSirnaTools, validateCandidateArguments } from '../packages/domain/sirna-tools/sirna-tools.mjs';

const target = 'ACGTACGTACGTACGTACGTA';

test('enumeration returns RNA reverse complements, inclusive coordinates and hand-calculated scores', () => {
  // 10/21 GC gives 0.7 + 0.15 * (1 - (10/21 - .425)/.125) + .08 = .8686.
  // 11/21 GC gives the same expression with 11/21, plus .04 instead of .08 = .7714.
  assert.deepEqual(enumerateCandidates('ACGTACGTACGTACGTACGTACGT'), {
    sequenceLength: 24, guideLength: 21, totalWindows: 4, returnedCandidates: 4,
    scoringMethod: 'transparent_prefilter_v1',
    candidates: [
      { id: 'SIRNA-00001', start: 1, end: 21, targetWindow: 'ACGUACGUACGUACGUACGUA',
        guide: 'UACGUACGUACGUACGUACGU', gcFraction: .4762, prefilterScore: .8686, warnings: [] },
      { id: 'SIRNA-00004', start: 4, end: 24, targetWindow: 'UACGUACGUACGUACGUACGU',
        guide: 'ACGUACGUACGUACGUACGUA', gcFraction: .4762, prefilterScore: .8686, warnings: [] },
      { id: 'SIRNA-00002', start: 2, end: 22, targetWindow: 'CGUACGUACGUACGUACGUAC',
        guide: 'GUACGUACGUACGUACGUACG', gcFraction: .5238, prefilterScore: .7714, warnings: [] },
      { id: 'SIRNA-00003', start: 3, end: 23, targetWindow: 'GUACGUACGUACGUACGUACG',
        guide: 'CGUACGUACGUACGUACGUAC', gcFraction: .5238, prefilterScore: .7714, warnings: [] },
    ],
  });
});

test('candidate limit is applied after ranking, keeping source-position IDs', () => {
  const result = enumerateCandidates('ACGTACGTACGTACGTACGTACGT', { maxCandidates: 2 });
  assert.equal(result.totalWindows, 4);
  assert.equal(result.returnedCandidates, 2);
  assert.deepEqual(result.candidates.map(({ id, start }) => ({ id, start })), [
    { id: 'SIRNA-00001', start: 1 }, { id: 'SIRNA-00004', start: 4 },
  ]);
});

test('equal scores prefer fewer warnings before the earlier coordinate', () => {
  // Both 20-base windows score .23: the second has .15 more GC penalty but no .15 diversity penalty.
  const result = enumerateCandidates('AAAAGGAAAAGGAAAAAAAAAAAAGCAAAATAAAAAAAAA', {
    guideLength: 20, maxCandidates: 500,
  });
  const first = result.candidates.find((candidate) => candidate.start === 1);
  const second = result.candidates.find((candidate) => candidate.start === 21);
  assert.equal(first.prefilterScore, .23);
  assert.equal(second.prefilterScore, .23);
  assert.equal(first.warnings.length, 3);
  assert.equal(second.warnings.length, 2);
  assert.ok(result.candidates.indexOf(second) < result.candidates.indexOf(first));
});

test('FASTA headings, whitespace, lowercase and RNA U normalize before enumeration', () => {
  const result = enumerateCandidates('  >target description\r\nacgu acgu\tacgu\r\nacguacgua\n');
  assert.equal(result.sequenceLength, 21);
  assert.equal(result.candidates[0].targetWindow, 'ACGUACGUACGUACGUACGUA');
  assert.equal(result.candidates[0].guide, 'UACGUACGUACGUACGUACGU');
  assert.equal(result.candidates[0].prefilterScore, .8686);
});

test('multiple FASTA records retain the documented concatenation behavior', () => {
  const result = enumerateCandidates('>first\nACGTACGTAC\n>second\nGTACGTACGTA');
  assert.equal(result.sequenceLength, 21);
  assert.equal(result.candidates[0].targetWindow, 'ACGUACGUACGUACGUACGUA');
});

test('homopolymers retain warnings even when negative scores clamp to zero', () => {
  for (const [sequence, gcFraction, gcWarning, guide] of [
    ['AAAAAAAAAAAAAAAAAAAAA', 0, 'gc_below_range', 'UUUUUUUUUUUUUUUUUUUUU'],
    ['GGGGGGGGGGGGGGGGGGGGG', 1, 'gc_above_range', 'CCCCCCCCCCCCCCCCCCCCC'],
  ]) {
    const candidate = enumerateCandidates(sequence).candidates[0];
    assert.equal(candidate.guide, guide);
    assert.equal(candidate.gcFraction, gcFraction);
    assert.equal(candidate.prefilterScore, 0);
    assert.deepEqual(candidate.warnings, [gcWarning, 'homopolymer_4_or_more', 'low_base_diversity']);
  }
});

test('alternating two-base sequences incur diversity penalty without a homopolymer warning', () => {
  const candidate = enumerateCandidates('ACACACACACACACACACACA').candidates[0];
  assert.equal(candidate.prefilterScore, .7186);
  assert.deepEqual(candidate.warnings, ['low_base_diversity']);
});

test('custom GC boundaries are inclusive and narrow ranges keep a finite score', () => {
  for (const options of [{ minGc: 10 / 21, maxGc: .6 }, { minGc: .3, maxGc: 10 / 21 }]) {
    const candidate = enumerateCandidates(target, options).candidates[0];
    assert.deepEqual(candidate.warnings, []);
    assert.equal(candidate.prefilterScore, .78);
  }
  assert.equal(enumerateCandidates(target, { minGc: .47, maxGc: .48 }).candidates[0].prefilterScore, .9121);
});

test('defaults cap returned candidates at 40 without changing the total window count', () => {
  const result = enumerateCandidates('ACGT'.repeat(16));
  assert.equal(result.guideLength, 21);
  assert.equal(result.totalWindows, 44);
  assert.equal(result.returnedCandidates, 40);
});

test('domain accepts inclusive guide and candidate bounds, including 500 internal candidates', () => {
  assert.equal(enumerateCandidates('A'.repeat(19), { guideLength: 19, maxCandidates: 1 }).totalWindows, 1);
  assert.equal(enumerateCandidates('A'.repeat(27), { guideLength: 27 }).totalWindows, 1);
  assert.equal(enumerateCandidates('ACGT'.repeat(150), { maxCandidates: 500 }).returnedCandidates, 500);
});

test('domain rejects invalid raw sequence types, lengths, symbols and empty normalized sequence', () => {
  for (const sequence of [null, undefined, 21, [], {}, '', 'A'.repeat(18), 'A'.repeat(100001)]) {
    assert.throws(() => enumerateCandidates(sequence), /targetSequence/);
  }
  for (const sequence of ['ACGTACGTACGTACGTACGTN', 'ACGTACGTACGTACGTACGT-', '>header with no sequence\n', ' '.repeat(21)]) {
    assert.throws(() => enumerateCandidates(sequence), /targetSequence/);
  }
  assert.throws(() => enumerateCandidates('>heading\nACGTACGTACGTACGTACG'), /at least 21 bases/);
});

test('domain rejects non-finite, wrong-type and unordered GC bounds', () => {
  for (const options of [
    { minGc: NaN }, { maxGc: NaN }, { minGc: Infinity }, { maxGc: -Infinity },
    { minGc: '0.3' }, { maxGc: null }, { minGc: -.1 }, { maxGc: 1.1 },
    { minGc: .6, maxGc: .5 }, { minGc: .5, maxGc: .5 },
  ]) {
    assert.throws(() => enumerateCandidates(target, options), /minGc.*maxGc/);
  }
});

test('domain rejects malformed options and noninteger guide or candidate limits', () => {
  for (const options of [null, [], 'options']) {
    assert.throws(() => enumerateCandidates(target, options), /options/);
  }
  for (const guideLength of [18, 28, 20.5, NaN, Infinity, '21', null]) {
    assert.throws(() => enumerateCandidates(target, { guideLength }), /guideLength/);
  }
  for (const maxCandidates of [0, 501, 1.5, NaN, Infinity, '40', null]) {
    assert.throws(() => enumerateCandidates(target, { maxCandidates }), /maxCandidates/);
  }
});

test('public tool rejects unknown keys instead of silently accepting internal GC controls', async () => {
  const tool = createSirnaTools()[0];
  for (const key of ['minGc', 'maxGc', 'extra']) {
    const args = { targetSequence: target, [key]: .3 };
    assert.throws(() => validateCandidateArguments(args), /unknown|unexpected/i);
    await assert.rejects(tool.execute('call-invalid', args), /unknown|unexpected/i);
  }
});

test('public runtime validation enforces required fields and the 100-candidate external limit', async () => {
  const tool = createSirnaTools()[0];
  for (const args of [null, [], {}, { targetSequence: 21 }, { targetSequence: 'A'.repeat(18) },
    { targetSequence: 'A'.repeat(100001) }, { targetSequence: target, guideLength: 18 },
    { targetSequence: target, guideLength: 21.5 }, { targetSequence: target, guideLength: '21' },
    { targetSequence: target, guideLength: null }, { targetSequence: target, maxCandidates: 0 },
    { targetSequence: target, maxCandidates: 101 }, { targetSequence: target, maxCandidates: NaN },
    { targetSequence: target, maxCandidates: '40' }, { targetSequence: target, maxCandidates: null },
  ]) {
    assert.throws(() => validateCandidateArguments(args));
    await assert.rejects(tool.execute('call-invalid', args));
  }
});

test('tool discovery exposes exactly one strict schema and execution returns matching JSON text and details', async () => {
  const tools = createSirnaTools();
  assert.equal(tools.length, 1);
  const tool = tools[0];
  assert.equal(tool.name, 'enumerate_sirna_candidates');
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(tool.parameters.required, ['targetSequence']);
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['guideLength', 'maxCandidates', 'targetSequence']);
  const response = await tool.execute('call-1', { targetSequence: target });
  assert.equal(response.content.length, 1);
  assert.equal(response.content[0].type, 'text');
  assert.deepEqual(JSON.parse(response.content[0].text), response.details);
  assert.equal(response.details.candidates[0].guide, 'UACGUACGUACGUACGUACGU');
  assert.equal(response.details.candidates[0].prefilterScore, .8686);
  await assert.rejects(tool.execute('call-bad-base', { targetSequence: 'N'.repeat(21) }), /targetSequence/);
});

test('public maximum raw sequence length executes with finite scores and a bounded result', async () => {
  const result = await createSirnaTools()[0].execute('call-max', {
    targetSequence: 'ACGT'.repeat(25000), maxCandidates: 100,
  });
  assert.equal(result.details.sequenceLength, 100000);
  assert.equal(result.details.totalWindows, 99980);
  assert.equal(result.details.returnedCandidates, 100);
  assert.ok(result.details.candidates.every(({ prefilterScore }) => Number.isFinite(prefilterScore)));
});
