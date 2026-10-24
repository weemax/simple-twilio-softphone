import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkTurn, checkGlobal, countQuestions, findPlaceholders,
  hasLink, hasPrice, renderedLength,
} from '../src/assertions.mjs';
import { isGsm7, nonGsm7Chars, segmentCount, septetLength } from '../src/gsm7.mjs';

const ok = (r) => assert.deepEqual(r.failures, [], r.failures.join('\n'));
const fails = (r, re) => {
  assert.ok(r.failures.length > 0, 'expected a failure, got none');
  assert.match(r.failures.join('\n'), re);
};

test('gsm7: straight vs curly apostrophe', () => {
  assert.ok(isGsm7("Hi, I'm Sarah with TruHome Pros."));
  assert.ok(!isGsm7('Hi, I’m Sarah with TruHome Pros.'));
  assert.deepEqual(nonGsm7Chars('Roof — it’s “urgent”'), ['—', '’', '“', '”']);
});

test('gsm7: emoji and accents are not GSM-7 basic', () => {
  assert.ok(!isGsm7('Thanks \u{1F44D}'));
  assert.ok(isGsm7('café'), 'e-acute is in the GSM-7 basic set');
  assert.ok(!isGsm7('naïve'), 'i-diaeresis is not');
});

test('gsm7: extension characters cost two septets', () => {
  assert.equal(septetLength('abc'), 3);
  assert.equal(septetLength('a[b]'), 6); // [ and ] are extension chars
  assert.equal(septetLength('\u{1F600}'), null);
});

test('gsm7: segment boundaries', () => {
  assert.equal(segmentCount('a'.repeat(160)), 1);
  assert.equal(segmentCount('a'.repeat(161)), 2);
  assert.equal(segmentCount('\u{1F600}' + 'a'.repeat(69)), 2, 'emoji forces UCS-2, 70-unit cap');
});

test('the criteria doc opening fits in one segment', () => {
  const opening = "Hi, I'm Sarah with TruHome Pros. What exterior project can I help with? Reply STOP to opt out.";
  assert.ok(isGsm7(opening));
  assert.ok(renderedLength(opening) <= 160);
  assert.equal(segmentCount(opening), 1);
  assert.equal(countQuestions(opening), 1);
});

test('countQuestions: no question mark still counts', () => {
  assert.equal(countQuestions('How old is the roof?'), 1);
  assert.equal(countQuestions('Let me know the roof age.'), 1);
  assert.equal(countQuestions('Let me know the roof age and whether it leaks.'), 2,
    'case 105: two asks, one sentence, zero question marks');
  assert.equal(countQuestions('How old is the roof? Does it leak?'), 2);
  assert.equal(countQuestions('What is the age; does it leak'), 2, 'semicolon-separated asks');
  assert.equal(countQuestions('Thanks, I have that noted.'), 0);
});

test('placeholder leaks', () => {
  assert.deepEqual(findPlaceholders('Hi {{contact.first_name}}!'), ['{{contact.first_name}}']);
  assert.deepEqual(findPlaceholders('We service [ADDRESS] now.'), ['[ADDRESS]']);
  assert.deepEqual(findPlaceholders('Your city is unknown.'), ['unknown']);
  assert.deepEqual(findPlaceholders('Moving to CONSULT stage.'), ['CONSULT']);
  assert.deepEqual(findPlaceholders('Hi Dana, what project?'), []);
});

test('price detection', () => {
  assert.ok(hasPrice('It runs about $8,000.'));
  assert.ok(hasPrice('Seniors get 20% off.'));
  assert.ok(hasPrice('Roughly 12000 for the job'));
  assert.ok(hasPrice('about $400 per square'));
  assert.ok(!hasPrice('The roof is 15 years old.'), 'age is not a price');
  assert.ok(!hasPrice('About 9 windows, is that right?'), 'a count is not a price');
});

test('link detection', () => {
  assert.ok(hasLink('Book here: https://book.truhome.com/x8Fa'));
  assert.ok(hasLink('Go to truhomepros.com/schedule'));
  assert.ok(!hasLink('Call us to schedule.'));
});

test('exact match requires exactly one message', () => {
  ok(checkTurn({ exact: 'Understood.' }, ['Understood.']));
  fails(checkTurn({ exact: 'Understood.' }, ['Understood.', 'Bye.']), /needs exactly 1 message/);
  fails(checkTurn({ exact: 'Understood.' }, ['understood.']), /exact mismatch/);
});

test('silence is violated by any message', () => {
  ok(checkTurn({ silence: 120 }, []));
  fails(checkTurn({ silence: 120 }, ['Still there?']), /expected silence/);
});

test('per-message checks run on every message in a burst', () => {
  const burst = ['Got it.', 'Also, how old is the roof and does it leak?'];
  fails(checkTurn({ max_questions: 1 }, burst), /message 2: 2 questions/);
});

test('link absent catches a link anywhere in the burst', () => {
  fails(checkTurn({ link: 'absent' }, ['Sure.', 'https://book.truhome.com/x']), /unexpected link/);
  ok(checkTurn({ link: 'present' }, ['Book: https://book.truhome.com/x']));
});

test('tool assertions', () => {
  const ctx = { toolCalls: [{ name: 'check_service_area', args: { city: 'Springfield', state: 'IL' } }] };
  ok(checkTurn({ tool_called: { name: 'check_service_area', args: { city: 'Springfield' } } }, ['ok'], ctx));
  fails(checkTurn({ tool_called: { name: 'check_service_area', args: { city: 'Peoria' } } }, ['ok'], ctx), /arg city/);
  fails(checkTurn({ tool_not_called: 'check_service_area' }, ['ok'], ctx), /was called/);
  ok(checkTurn({ tool_not_called: 'appointment_booked' }, ['ok'], ctx));
});

test('unknown assertion keys fail loudly rather than passing silently', () => {
  fails(checkTurn({ definitely_not_a_check: true }, ['hi']), /unknown assertion/);
});

test('semantic clauses are handed off, not evaluated here', () => {
  const r = checkTurn({ must: ['Directs to emergency services'], must_not: ['Asks a question'] }, ['Call 911.']);
  assert.deepEqual(r.failures, []);
  assert.deepEqual(r.semantic.must, ['Directs to emergency services']);
  assert.deepEqual(r.semantic.must_not, ['Asks a question']);
});

test('global assertions apply per case and honor exemptions', () => {
  const g = {
    expect: { max_chars: 160, gsm7_only: true, max_questions: 1 },
    exempt: [{ id: '101', field: 'max_chars', reason: 'probes the boundary' }],
  };
  assert.deepEqual(checkGlobal(g, ['Short and clean.'], '047'), []);
  assert.match(checkGlobal(g, ['x'.repeat(200)], '047').join(), /\[global\] rendered length 200/);
  assert.deepEqual(checkGlobal(g, ['x'.repeat(200)], '101'), [], 'case 101 is exempt from max_chars');
  assert.match(checkGlobal(g, ['Roof — ok'], '101').join(), /non-GSM-7/, 'exemption is per-field, not per-case');
});
