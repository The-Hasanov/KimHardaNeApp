'use strict';
const { fold } = require('./store');

const JUDGE_THRESHOLDS = { correctAt: 0.86, unsureAt: 0.6 };
const CREDITING_RULE_WORDS = /(yalniz|deqiq|menaca|menaya|mentiq|oxsar|uygun|cavablar|nezere|qebul|uzre|ve s\b)/;
const EXACT_ANSWERS_ONLY = /yalniz deqiq/;
const SHORTEST_MEANING_MATCH = 5;

const compact = text => fold(text ?? '').replace(/[^\p{L}\p{N}]+/gu, '');
const JOINING_WORDS = new Set(['ve', 'va', 'ile', 'and']);
// Players without an Azerbaijani keyboard type "a" for "ə", "sh" for "ş" and "ch" for "ç".
const latin = text => fold(text).replace(/sh/g, 's').replace(/ch/g, 'c');
const spellings = text => [...new Set([latin(text ?? ''), latin((text ?? '').replace(/[əƏ]/g, 'a'))])];
const words = text => text.split(/[^\p{L}\p{N}]+/u).filter(word => word && !JOINING_WORDS.has(word));
const listParts = text => text.split(/[,;&]|\s(?:ve|va|ile|and)\s/).map(words).filter(part => part.length);
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);

function answerCandidates(question) {
  const accepted = question.accepted_answers ?? '';
  const isRule = text => CREDITING_RULE_WORDS.test(fold(text));
  const alternatives = accepted.split(/[;,/\n]| və ya /i).map(part => part.trim()).filter(part => compact(part).length > 1 && !isRule(part));
  const wholeAccepted = isRule(accepted) ? [] : [accepted];
  return [...new Set([question.answer, ...wholeAccepted, ...alternatives].filter(text => compact(text)))];
}

function editDistance(a, b) {
  let [beforePrevious, previous] = [[], Array.from({ length: b.length + 1 }, (_, j) => j)];
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) current[j] = Math.min(current[j], beforePrevious[j - 2] + 1);
    }
    [beforePrevious, previous] = [previous, current];
  }
  return previous[b.length];
}

const typosAllowed = length => (length >= 9 ? 2 : length >= 5 ? 1 : 0);

const sameWords = (givenWords, candidateWords) => givenWords.length === candidateWords.length
  && candidateWords.every((word, i) => editDistance(givenWords[i], word) <= typosAllowed(word.length));

// List answers ("Adəm, Həvva") match in any order.
function sameList(given, candidate) {
  const left = listParts(candidate);
  return left.length > 1 && listParts(given).length === left.length && listParts(given).every(part => {
    const i = left.findIndex(other => sameWords(part, other));
    return i >= 0 && left.splice(i, 1);
  });
}

function matchesAsText(given, candidate) {
  if (compact(given) === compact(candidate)) return true;
  const [typed] = spellings(given);
  return spellings(candidate).some(expected => sameWords(words(typed), words(expected)) || sameList(typed, expected));
}

async function judgeAnswer(question, given, embedTexts) {
  if (!compact(given)) return { verdict: 'wrong', similarity: null, closestAnswer: null, method: null };
  if (!embedTexts) return { verdict: 'unsure', similarity: null, closestAnswer: null, method: 'host' };
  const candidates = answerCandidates(question);
  const textMatch = candidates.find(candidate => matchesAsText(given, candidate));
  if (textMatch) return { verdict: 'correct', similarity: 1, closestAnswer: textMatch, method: 'text' };
  const exactOnly = EXACT_ANSWERS_ONLY.test(fold(question.accepted_answers ?? ''));
  const comparable = exactOnly ? [] : candidates.filter(candidate => compact(candidate).length >= SHORTEST_MEANING_MATCH);
  if (!comparable.length || compact(given).length < SHORTEST_MEANING_MATCH - 1) {
    return { verdict: 'wrong', similarity: null, closestAnswer: null, method: 'text' };
  }
  const [givenVector, ...candidateVectors] = await embedTexts([given, ...comparable]);
  const [similarity, closestAnswer] = comparable
    .map((candidate, i) => [dot(givenVector, candidateVectors[i]), candidate])
    .sort((a, b) => b[0] - a[0])[0];
  const verdict = similarity >= JUDGE_THRESHOLDS.correctAt ? 'correct' : similarity >= JUDGE_THRESHOLDS.unsureAt ? 'unsure' : 'wrong';
  return { verdict, similarity, closestAnswer, method: 'ai' };
}

module.exports = { JUDGE_THRESHOLDS, answerCandidates, editDistance, matchesAsText, judgeAnswer };
