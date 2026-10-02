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
const ROMAN = /^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;
const ROMAN_VALUES = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
const romanValue = numeral => [...numeral].reduce((sum, letter, i) => {
  const value = ROMAN_VALUES[letter];
  return sum + (value < (ROMAN_VALUES[numeral[i + 1]] ?? 0) ? -value : value);
}, 0);
const ROMAN_BESIDE_A_NAME = /(?<![\p{L}\p{N}.])[IVX](?=\s+\p{Lu})|(?<=\p{Lu}\p{Ll}+\s+)[IVX](?![\p{L}\p{N}])/gu;
const ROMAN_WORD = /(?<![\p{L}\p{N}])[MDCLXVI]{2,}(?![\p{L}\p{N}])/gu;
const TYPED_ROMAN_WORD = /(?<![\p{L}\p{N}]|\d[\s'’-]*)[mdclxvi]{2,}(?![\p{L}\p{N}])/giu;
const NUMERIC_DATE = /\b(\d{1,2})[./](\d{1,2})[./](\d{2,4})\b/g;
const CARDINALS = {
  bir: 1, iki: 2, uc: 3, dord: 4, bes: 5, alti: 6, yeddi: 7, sekkiz: 8, doqquz: 9, on: 10, iyirmi: 20, otuz: 30, qirx: 40,
  elli: 50, altmis: 60, yetmis: 70, seksen: 80, doxsan: 90, yuz: 100, min: 1000, milyon: 1e6, milyard: 1e9,
};
const ordinalOf = word => {
  const vowel = /[ou][^aeiou]*$/.test(word) ? 'u' : 'i';
  return /[aeiou]$/.test(word) ? `${word}nc${vowel}` : `${word}${vowel}nc${vowel}`;
};
const ORDINALS = Object.fromEntries(Object.entries(CARDINALS).map(([word, value]) => [ordinalOf(word), value]));
const MONTHS = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avqust', 'sentyabr', 'oktyabr', 'noyabr', 'dekabr'];
const monthOf = word => MONTHS.findIndex(month => word === month || (month.length > 3 && word.startsWith(month) && word.length - month.length <= 4)) + 1;
const numberWordValue = word => CARDINALS[word] ?? ORDINALS[word] ?? CARDINALS[word.replace(/a/g, 'e')] ?? ORDINALS[word.replace(/a/g, 'e')];

function writtenNumbers(foldedWords) {
  const numbers = [];
  let total = 0, current = 0, wordsInNumber = [];
  const finish = () => {
    if (wordsInNumber.length && !(wordsInNumber.length === 1 && wordsInNumber[0] === 'bir')) numbers.push(total + current);
    total = current = 0;
    wordsInNumber = [];
  };
  for (const word of foldedWords) {
    const value = numberWordValue(word);
    if (value === undefined) {
      finish();
      continue;
    }
    if (value >= 1000) {
      total += (current || 1) * value;
      current = 0;
    } else if (value === 100) current = (current || 1) * 100;
    else current += value;
    wordsInNumber.push(word);
    if (ORDINALS[word] !== undefined || ORDINALS[word.replace(/a/g, 'e')] !== undefined) finish();
  }
  finish();
  return numbers;
}

function numbersIn(text, { typed = false } = {}) {
  const found = new Set();
  const withoutDates = (text ?? '').replace(NUMERIC_DATE, (_, day, month, year) => {
    found.add(`month ${+month}`);
    return `${day} ${year}`;
  });
  for (const digits of withoutDates.match(/\d+/g) ?? []) found.add(String(+digits));
  for (const [numeral] of withoutDates.matchAll(ROMAN_BESIDE_A_NAME)) found.add(String(romanValue(numeral)));
  for (const [word] of withoutDates.matchAll(typed ? TYPED_ROMAN_WORD : ROMAN_WORD)) {
    if (ROMAN.test(word.toUpperCase())) found.add(String(romanValue(word.toUpperCase())));
  }
  const foldedWords = latin(withoutDates).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const number of writtenNumbers(foldedWords)) found.add(String(number));
  for (const word of foldedWords) if (monthOf(word)) found.add(`month ${monthOf(word)}`);
  return found;
}

function numbersKept(given, candidate) {
  const typed = numbersIn(given, { typed: true });
  if ([...numbersIn(candidate)].every(number => typed.has(number))) return 'kept';
  return typed.size ? 'changed' : 'missing';
}

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

const singleWordNumber = word => (/^\d+$/.test(word) ? +word : numberWordValue(word)
  ?? (word.length > 1 && ROMAN.test(word.toUpperCase()) ? romanValue(word.toUpperCase()) : undefined));
const sameNumberWord = (given, expected) => singleWordNumber(expected) !== undefined && singleWordNumber(given) === singleWordNumber(expected);
const sameWords = (givenWords, candidateWords) => givenWords.length === candidateWords.length
  && candidateWords.every((word, i) => editDistance(givenWords[i], word) <= typosAllowed(word.length) || sameNumberWord(givenWords[i], word));

// List answers ("Adəm, Həvva") match in any order.
function sameList(given, candidate) {
  const left = listParts(candidate);
  return left.length > 1 && listParts(given).length === left.length && listParts(given).every(part => {
    const i = left.findIndex(other => sameWords(part, other));
    return i >= 0 && left.splice(i, 1);
  });
}

const compactSpellings = text => spellings(text).map(spelling => spelling.replace(/[^\p{L}\p{N}]+/gu, ''));
const matchesExactly = (given, candidate) => compactSpellings(given).some(typed => compactSpellings(candidate).includes(typed));
const isListComplete = (given, candidate) => listParts(latin(given)).length >= listParts(latin(candidate)).length;

function matchesAsText(given, candidate) {
  if (compact(given) === compact(candidate)) return true;
  if (numbersKept(given, candidate) !== 'kept') return false;
  const [typed] = spellings(given);
  return spellings(candidate).some(expected => sameWords(words(typed), words(expected)) || sameList(typed, expected));
}

async function judgeAnswer(question, given, embedTexts, thresholds = JUDGE_THRESHOLDS) {
  if (!compact(given)) return { verdict: 'wrong', similarity: null, closestAnswer: null, method: null };
  if (!embedTexts) return { verdict: 'unsure', similarity: null, closestAnswer: null, method: 'host' };
  const candidates = answerCandidates(question);
  const exactOnly = EXACT_ANSWERS_ONLY.test(fold(question.accepted_answers ?? ''));
  const textMatch = candidates.find(candidate => (exactOnly ? matchesExactly(given, candidate) : matchesAsText(given, candidate)));
  if (textMatch) return { verdict: 'correct', similarity: 1, closestAnswer: textMatch, method: 'text' };
  const comparable = exactOnly ? [] : candidates.filter(candidate => compact(candidate).length >= SHORTEST_MEANING_MATCH && numbersKept(given, candidate) !== 'changed');
  if (!comparable.length || compact(given).length < SHORTEST_MEANING_MATCH - 1) {
    return { verdict: 'wrong', similarity: null, closestAnswer: null, method: 'text' };
  }
  const [givenVector, ...candidateVectors] = await embedTexts([given, ...comparable]);
  const VERDICT_RANK = { correct: 2, unsure: 1, wrong: 0 };
  const [best] = comparable.map((candidate, i) => {
    const similarity = dot(givenVector, candidateVectors[i]);
    const byMeaning = similarity >= thresholds.correctAt ? 'correct' : similarity >= thresholds.unsureAt ? 'unsure' : 'wrong';
    const isWholeAnswer = numbersKept(given, candidate) === 'kept' && isListComplete(given, candidate);
    return { verdict: byMeaning === 'correct' && !isWholeAnswer ? 'unsure' : byMeaning, similarity, closestAnswer: candidate, method: 'ai' };
  }).sort((a, b) => VERDICT_RANK[b.verdict] - VERDICT_RANK[a.verdict] || b.similarity - a.similarity);
  return best;
}

module.exports = { JUDGE_THRESHOLDS, answerCandidates, editDistance, matchesAsText, matchesExactly, numbersIn, judgeAnswer };
