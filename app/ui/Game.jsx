import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { cn } from 'cn';
import {
  ArrowRightIcon, EyeIcon, FlagIcon, Gamepad2Icon, ImageIcon, PauseIcon, PlayIcon, PresentationIcon, RotateCcwIcon, SettingsIcon,
  LayoutTemplateIcon, ShuffleIcon, SigmaIcon, SkipForwardIcon, SparklesIcon, TrophyIcon, UserRoundIcon, UsersIcon,
} from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  KEY_HINT_ON_PRIMARY_BUTTON, MIN_SECONDS_TO_CHECK_ANSWERS, Media, NextQuestionNumber, NumberField, QuestionSourceSelect, QuestionOnScreen, WARNING_AT_SECONDS_LEFT, formatClock, playTenSecondsLeftTone,
  playTimeUpTone, withLineBreaks, withoutIpcPrefix,
} from './gameShared';
import PartyScreen, { AllTimeLeaderboard } from './Party';
import Profiles from './Profiles';
import PointSystems, { usePointSystems } from './PointSystems';
import RoundPlan, { NEW_ROUND, pointSystemOf, roundProblem } from './RoundPlan';
import Templates from './Templates';
import { PlayHistory, PlayResults, PlayRound } from './Play';

const { api } = window;
const DEFAULT_RANDOM_COUNT = 10;
const MAX_RANDOM_COUNT = 50;
const DEFAULT_SECONDS_PER_QUESTION = 60;
const MAX_SECONDS_BETWEEN_QUESTIONS = 120;
const RANDOM_GAME_TITLE = 'Random · Nə? Harada? Nə zaman?';

const MODE_DESCRIPTIONS = {
  host: summary => `Host mode: ${summary} and a timer. Answers stay hidden until you end the game.`,
  play: summary => `Play mode: answer ${summary} yourself against the clock, then mark each answer correct or wrong, or let AI search check it.`,
  party: summary => `Party mode: players join from any phone, tablet or computer with a web browser (scan the QR code or type the address), then play ${summary} on their own screens. You mark the answers, or AI search checks them; scores add up over the rounds.`,
};
const TIMING_HELP = {
  host: "Between questions the next question's number fills the screen; Space skips the wait. Auto-start starts each question's timer as soon as the question appears.",
  play: "Between questions the next question's number fills the screen; Space skips the wait. Each question's timer starts as soon as it appears.",
};

function RoundSettings({ mode, questions, lists, listId, onListIdChange, onNewSet, settings, onSettingsChange, action }) {
  const chosenList = lists.find(list => list.id === listId);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <QuestionSourceSelect id="question-source" lists={lists} listId={listId} onListIdChange={onListIdChange} />
        {!chosenList && <>
          <NumberField id="random-question-count" label="How many" value={settings.randomCount} min={1} max={MAX_RANDOM_COUNT}
            onChange={randomCount => onSettingsChange({ randomCount })} />
          <Button variant="outline" onClick={onNewSet} disabled={!questions}><ShuffleIcon />New set</Button>
        </>}
        <div className="ml-auto">{action}</div>
      </div>
      {!chosenList && (
        <RadioGroup value={settings.includeOwn ? 'with-own' : 'bank'} onValueChange={value => onSettingsChange({ includeOwn: value === 'with-own' })}
          className="flex flex-wrap gap-x-6 gap-y-2">
          <div className="flex items-center gap-2">
            <RadioGroupItem id="random-from-bank" value="bank" />
            <Label htmlFor="random-from-bank" className="font-normal">Only Nə? Harada? Nə zaman?</Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem id="random-with-own" value="with-own" />
            <Label htmlFor="random-with-own" className="font-normal">Include my questions (picked first)</Label>
          </div>
        </RadioGroup>
      )}
      <div className="flex flex-wrap items-end gap-x-6 gap-y-4 rounded-lg border p-4">
        <NumberField id="seconds-per-question" label="Seconds per question" value={settings.secondsPerQuestion} min={10} max={600} step={5}
          onChange={secondsPerQuestion => onSettingsChange({ secondsPerQuestion })} />
        <NumberField id="seconds-between-questions" label="Seconds between questions" value={settings.secondsBetweenQuestions}
          min={0} max={MAX_SECONDS_BETWEEN_QUESTIONS} step={5} onChange={secondsBetweenQuestions => onSettingsChange({ secondsBetweenQuestions })} />
        {mode === 'host' && (
          <div className="flex h-8 items-center gap-2">
            <Switch id="auto-start-next-question" checked={settings.shouldAutoStartTimer}
              onCheckedChange={shouldAutoStartTimer => onSettingsChange({ shouldAutoStartTimer })} />
            <Label htmlFor="auto-start-next-question" className="font-normal">Auto-start next question</Label>
          </div>
        )}
        <p className="basis-full text-xs text-muted-foreground">{TIMING_HELP[mode]}</p>
      </div>
    </div>
  );
}

function GameSetup({ mode, onModeChange, isAiReady, onOpenSettings, onStart, roundPlan, planSummary, canOpenParty, ...roundSettings }) {
  const { questions, lists, listId } = roundSettings;
  const chosenList = lists.find(list => list.id === listId);
  const needsAi = mode !== 'host';
  const questionsSummary = mode === 'party' ? planSummary : chosenList ? `the ${questions?.length ?? chosenList.count} questions of this list` : `${questions?.length ?? roundSettings.settings.randomCount} random questions`;
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-6 py-8">
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          <h1 className="text-2xl font-semibold">{chosenList && mode !== 'party' ? chosenList.name : 'Nə? Harada? Nə zaman?'}</h1>
          <p className="text-muted-foreground">{MODE_DESCRIPTIONS[mode](questionsSummary)}</p>
        </div>
        <Tabs value={mode} onValueChange={onModeChange}>
          <TabsList>
            <TabsTrigger value="host" className="px-2.5"><PresentationIcon />Host</TabsTrigger>
            <TabsTrigger value="play" className="px-2.5"><Gamepad2Icon />Play</TabsTrigger>
            <TabsTrigger value="party" className="px-2.5"><UsersIcon />Party</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {needsAi && !isAiReady && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
          <SparklesIcon className="size-4 shrink-0" />
          <span className="flex-1">AI search is off, so {mode === 'party' ? 'you mark every answer' : 'you mark each of your answers'} correct or wrong. Turn it on in Settings to check answers automatically.</span>
          <Button size="sm" variant="outline" onClick={onOpenSettings}><SettingsIcon />Open Settings</Button>
        </div>
      )}
      {mode === 'party' ? roundPlan(<Button onClick={onStart} disabled={!canOpenParty}><UsersIcon />Open party</Button>) : (
        <RoundSettings mode={mode} {...roundSettings} action={
          <Button size="lg" onClick={onStart} disabled={!questions?.length}><PlayIcon />Start game</Button>
        } />
      )}
      {mode === 'party' ? null : !questions ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />Loading questions…</div>
      ) : mode === 'play' ? <PlayHistory isVisible /> : mode === 'host' && (
        <ol className="divide-y rounded-lg border">
          {questions.map((question, position) => (
            <li key={question.uid} className="flex gap-3 px-4 py-3 text-sm">
              <span className="w-5 shrink-0 text-right font-medium text-muted-foreground tabular-nums">{position + 1}</span>
              <span className="line-clamp-2 flex-1 whitespace-pre-line">{withLineBreaks(question.text)}</span>
              {question.rekvizit_src && <ImageIcon className="size-4 shrink-0 text-muted-foreground" aria-label="Has a handout" />}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

const GAME_SECTIONS = [['play', PlayIcon, 'Play'], ['templates', LayoutTemplateIcon, 'Templates'], ['points', SigmaIcon, 'Point systems'], ['profiles', UserRoundIcon, 'Profiles'], ['leaderboard', TrophyIcon, 'Leaderboard']];

function GameSections({ section, onSectionChange, children }) {
  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b">
        <Tabs value={section} onValueChange={onSectionChange} className="mx-auto max-w-3xl px-6">
          <TabsList variant="line" className="h-10">
            {GAME_SECTIONS.map(([value, Icon, label]) => (
              <TabsTrigger key={value} value={value} className="px-2.5"><Icon />{label}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

function AnswerCard({ question, number, isRevealed, onReveal }) {
  return (
    <div id={`answer-${number}`} className={cn('space-y-3 rounded-lg border p-5', isRevealed && 'border-primary/40')}>
      <div className="flex items-center gap-2">
        <Badge variant="secondary">Question {number}</Badge>
        {!isRevealed && <Button size="sm" variant="outline" className="ml-auto" onClick={onReveal}><EyeIcon />Reveal answer</Button>}
      </div>
      <p className="line-clamp-4 text-sm whitespace-pre-line text-muted-foreground">{withLineBreaks(question.text)}</p>
      {isRevealed ? (
        <div className="space-y-2 animate-in fade-in-0">
          <p className="text-2xl font-semibold">{question.answer}</p>
          {question.accepted_answers && (
            <p className="text-sm"><span className="text-muted-foreground">Also accepted: </span>{question.accepted_answers}</p>
          )}
          {question.comment && <p className="text-sm whitespace-pre-line text-muted-foreground">{question.comment}</p>}
          {question.source_media_src && <Media src={question.source_media_src} kind={question.source_media_kind} alt="Answer" className="max-h-72" />}
        </div>
      ) : <div className="h-8 rounded-md bg-muted" aria-label="Answer hidden" />}
    </div>
  );
}

export default function Game({ isVisible, lists, listId, onListIdChange, isAiReady, onOpenSettings }) {
  const [mode, setMode] = useState(() => localStorage.getItem('gameMode') ?? 'host');
  const [playGameId, setPlayGameId] = useState(null);
  const [phase, setPhase] = useState('setup');
  const [section, setSection] = useState('play');
  const [questions, setQuestions] = useState(null);
  const [secondsPerQuestion, setSecondsPerQuestion] = useState(DEFAULT_SECONDS_PER_QUESTION);
  const [secondsBetweenQuestions, setSecondsBetweenQuestions] = useState(0);
  const [shouldAutoStartTimer, setShouldAutoStartTimer] = useState(false);
  const [pointSystems, setPointSystems] = usePointSystems();
  const [plan, setPlan] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('partyPlan'));
      if (Array.isArray(saved) && saved.length) return saved.map(round => ({ ...NEW_ROUND, ...round }));
    } catch {}
    return [{ ...NEW_ROUND }];
  });
  const [templateName, setTemplateName] = useState(() => localStorage.getItem('partyPlanTemplate'));
  const [templates, setTemplates] = useState(null);
  const [randomCount, setRandomCount] = useState(() => Number(localStorage.getItem('randomQuestionCount')) || DEFAULT_RANDOM_COUNT);
  const [includeOwn, setIncludeOwn] = useState(() => localStorage.getItem('includeOwnQuestions') === '1');
  const [partyState, setPartyState] = useState(null);
  const [waitEndsAt, setWaitEndsAt] = useState(null);
  const [waitSecondsLeft, setWaitSecondsLeft] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(DEFAULT_SECONDS_PER_QUESTION);
  const [timerEndsAt, setTimerEndsAt] = useState(null);
  const [playedCount, setPlayedCount] = useState(0);
  const [revealedIndexes, setRevealedIndexes] = useState(new Set());
  const [isConfirmingEnd, setIsConfirmingEnd] = useState(false);
  const tenSecondWarningPlayed = useRef(false);
  const handleKeyDown = useRef(null);
  const listIdOfQuestions = useRef(null);

  const pickQuestions = ({ count = randomCount, withOwn = includeOwn } = {}) => {
    setQuestions(null);
    listIdOfQuestions.current = listId;
    const loading = listId == null ? api.gameQuestions(count, withOwn) : api.listQuestions(listId);
    loading.then(setQuestions, e => toast.error('Could not load questions', { description: e.message }));
  };
  useEffect(() => {
    if (!isVisible || phase !== 'setup' || mode === 'party') return;
    if (listId != null || !questions || listIdOfQuestions.current !== listId) pickQuestions();
  }, [isVisible, listId, mode]);

  const resetTimer = () => {
    setTimerEndsAt(null);
    setSecondsLeft(secondsPerQuestion);
    tenSecondWarningPlayed.current = false;
  };
  const startFreshTimer = index => {
    setPlayedCount(count => Math.max(count, index + 1));
    setTimerEndsAt(Date.now() + secondsPerQuestion * 1000);
  };
  const showQuestion = index => {
    setWaitEndsAt(null);
    setCurrentIndex(index);
    resetTimer();
    if (shouldAutoStartTimer) startFreshTimer(index);
  };
  const moveToQuestion = index => {
    if (!secondsBetweenQuestions) return showQuestion(index);
    resetTimer();
    setCurrentIndex(index);
    setWaitSecondsLeft(secondsBetweenQuestions);
    setWaitEndsAt(Date.now() + secondsBetweenQuestions * 1000);
  };
  const changeMode = nextMode => {
    setMode(nextMode);
    localStorage.setItem('gameMode', nextMode);
  };
  const startGame = async () => {
    if (mode === 'party') return openParty();
    if (mode === 'play') {
      const title = lists.find(list => list.id === listId)?.name ?? RANDOM_GAME_TITLE;
      setPlayGameId(await api.startPlayGame({ title, listId, secondsPerQuestion, questionCount: questions.length }));
      return setPhase('playing');
    }
    setPlayedCount(0);
    setPhase('hosting');
    moveToQuestion(0);
  };
  const backToSetup = () => {
    setPhase('setup');
    pickQuestions();
  };
  const changePlan = rounds => {
    setPlan(rounds);
    localStorage.setItem('partyPlan', JSON.stringify(rounds));
  };
  const changeTemplateName = name => {
    setTemplateName(name);
    if (name) localStorage.setItem('partyPlanTemplate', name);
    else localStorage.removeItem('partyPlanTemplate');
  };
  const planProblems = plan.map(round => roundProblem(round, lists, pointSystems));
  const planSummary = `${plan.length} ${plan.length === 1 ? 'round' : 'rounds'}`;
  const roundPlan = (playedCount, action) => (
    <RoundPlan rounds={plan} onRoundsChange={changePlan} lists={lists} pointSystems={pointSystems} templates={templates} onTemplatesChange={setTemplates}
      templateName={templateName} onTemplateNameChange={changeTemplateName} playedCount={playedCount} action={action} />
  );
  const roundSettingsValues = {
    secondsPerQuestion, secondsBetweenQuestions, shouldAutoStartTimer, randomCount, includeOwn,
  };
  const changeRoundSettings = changes => {
    if ('secondsPerQuestion' in changes) {
      setSecondsPerQuestion(changes.secondsPerQuestion);
      setSecondsLeft(changes.secondsPerQuestion);
    }
    if ('secondsBetweenQuestions' in changes) setSecondsBetweenQuestions(changes.secondsBetweenQuestions);
    if ('shouldAutoStartTimer' in changes) setShouldAutoStartTimer(changes.shouldAutoStartTimer);
    if ('randomCount' in changes) {
      setRandomCount(changes.randomCount);
      localStorage.setItem('randomQuestionCount', String(changes.randomCount));
      pickQuestions({ count: changes.randomCount });
    }
    if ('includeOwn' in changes) {
      setIncludeOwn(changes.includeOwn);
      localStorage.setItem('includeOwnQuestions', changes.includeOwn ? '1' : '0');
      pickQuestions({ withOwn: changes.includeOwn });
    }
  };
  const roundSettingsProps = {
    questions, lists, listId, onListIdChange, onNewSet: () => pickQuestions(), settings: roundSettingsValues, onSettingsChange: changeRoundSettings,
  };
  useEffect(() => {
    api.pointSystems().then(setPointSystems);
    api.gameTemplates().then(setTemplates);
  }, [section]);
  useEffect(() => { api.onParty(setPartyState); }, []);
  const openParty = async () => {
    try {
      setPartyState(await api.partyOpen());
      setPhase('party');
    } catch (e) {
      toast.error('Could not open the party', { description: e.message });
    }
  };
  const [isStartingRound, setIsStartingRound] = useState(false);
  const startPartyRound = async () => {
    const round = plan[partyState.round];
    if (!round) return;
    setIsStartingRound(true);
    try {
      const roundQuestions = await (round.listId == null ? api.gameQuestions(round.randomCount, round.includeOwn) : api.listQuestions(round.listId));
      await api.partyStartRound({
        uids: roundQuestions.map(question => question.uid), secondsPerQuestion: round.secondsPerQuestion, pointSystemId: pointSystemOf(round, pointSystems)?.id,
        secondsBetweenQuestions: round.revealAtEnd ? Math.max(round.secondsBetweenQuestions, MIN_SECONDS_TO_CHECK_ANSWERS) : round.secondsBetweenQuestions,
        secondsOnAnswer: round.secondsOnAnswer, revealAtEnd: round.revealAtEnd,
      });
    } catch (e) {
      toast.error('Could not start the round', { description: withoutIpcPrefix(e) });
    }
    setIsStartingRound(false);
  };
  const applyTemplate = template => {
    changePlan(template.rounds);
    changeTemplateName(template.name);
    changeMode('party');
    setSection('play');
  };
  const partyBackToLobby = keepScores => api.partyBackToLobby(keepScores);

  const closeParty = async () => {
    await api.partyClose();
    setPartyState(null);
    backToSetup();
  };
  const endGame = () => {
    setWaitEndsAt(null);
    resetTimer();
    setRevealedIndexes(new Set());
    setIsConfirmingEnd(false);
    setPhase('answers');
  };
  const goToNextQuestion = ({ becauseTimeIsUp = false } = {}) => {
    if (currentIndex + 1 >= questions.length) return endGame();
    moveToQuestion(currentIndex + 1);
    if (!becauseTimeIsUp || secondsBetweenQuestions) return;
    toast.info(shouldAutoStartTimer ? `Time's up. Question ${currentIndex + 2} started.` : `Time's up. Question ${currentIndex + 2} of ${questions.length} is ready.`);
  };
  const startTimer = () => {
    setPlayedCount(count => Math.max(count, currentIndex + 1));
    setTimerEndsAt(Date.now() + secondsLeft * 1000);
  };
  const pauseTimer = () => {
    setSecondsLeft(Math.max(0, (timerEndsAt - Date.now()) / 1000));
    setTimerEndsAt(null);
  };
  const revealAnswer = index => setRevealedIndexes(revealed => new Set(revealed).add(index));
  const revealNextAnswer = () => {
    const nextHidden = questions.slice(0, playedCount).findIndex((_, index) => !revealedIndexes.has(index));
    if (nextHidden < 0) return;
    revealAnswer(nextHidden);
    requestAnimationFrame(() => document.getElementById(`answer-${nextHidden + 1}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  };

  useEffect(() => {
    if (!timerEndsAt) return;
    const countdown = setInterval(() => {
      const remaining = (timerEndsAt - Date.now()) / 1000;
      if (remaining <= WARNING_AT_SECONDS_LEFT && !tenSecondWarningPlayed.current) {
        tenSecondWarningPlayed.current = true;
        playTenSecondsLeftTone();
      }
      if (remaining > 0) return setSecondsLeft(remaining);
      clearInterval(countdown);
      playTimeUpTone();
      goToNextQuestion({ becauseTimeIsUp: true });
    }, 100);
    return () => clearInterval(countdown);
  }, [timerEndsAt]);

  useEffect(() => {
    if (!waitEndsAt) return;
    const countdown = setInterval(() => {
      const remaining = (waitEndsAt - Date.now()) / 1000;
      if (remaining > 0) return setWaitSecondsLeft(remaining);
      clearInterval(countdown);
      showQuestion(currentIndex);
    }, 100);
    return () => clearInterval(countdown);
  }, [waitEndsAt]);

  handleKeyDown.current = e => {
    const isTypingOrOnAControl = e.target.closest?.('input, textarea, button, [role=dialog], [role=alertdialog]');
    if (!isVisible || isTypingOrOnAControl) return;
    if ((e.key === ' ' || e.key === 'ArrowRight') && phase === 'hosting' && waitEndsAt) showQuestion(currentIndex);
    else if (e.key === ' ' && phase === 'hosting') (timerEndsAt ? pauseTimer : startTimer)();
    else if (e.key === ' ' && phase === 'answers') revealNextAnswer();
    else if (e.key === 'ArrowRight' && phase === 'hosting') goToNextQuestion();
    else return;
    e.preventDefault();
  };
  useEffect(() => {
    const listener = e => handleKeyDown.current(e);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  if (phase === 'setup') {
    return (
      <GameSections section={section} onSectionChange={setSection}>
        {section === 'templates' ? (
          <Templates templates={templates} onTemplatesChange={setTemplates} lists={lists} pointSystems={pointSystems} onUse={applyTemplate}
            onPlanNew={() => { changeMode('party'); changeTemplateName(null); setSection('play'); }} />
        ) : section === 'points' ? <PointSystems /> : section === 'profiles' ? <Profiles /> : section === 'leaderboard' ? (
          <div className="mx-auto max-w-3xl px-6 py-8"><AllTimeLeaderboard /></div>
        ) : (
          <GameSetup mode={mode} onModeChange={changeMode} isAiReady={isAiReady} onOpenSettings={onOpenSettings} onStart={startGame}
            {...roundSettingsProps} roundPlan={action => roundPlan(0, action)} planSummary={planSummary} canOpenParty={!!pointSystems && planProblems.every(problem => !problem)} />
        )}
      </GameSections>
    );
  }

  if (phase === 'party' && partyState) {
    return (
      <PartyScreen party={partyState} isVisible={isVisible} onBackToLobby={partyBackToLobby} onClose={closeParty}
        lobbySettings={roundPlan(partyState.round, (
          <Button onClick={startPartyRound} disabled={isStartingRound || !plan[partyState.round] || !partyState.players.length || !!planProblems[partyState.round]}>
            <PlayIcon />{plan[partyState.round] ? `Start round ${partyState.round + 1}` : 'No round left'}
          </Button>
        ))} />
    );
  }

  if (phase === 'playing') {
    return (
      <PlayRound key={playGameId} gameId={playGameId} questions={questions} secondsPerQuestion={secondsPerQuestion}
        secondsBetweenQuestions={secondsBetweenQuestions} isVisible={isVisible} onFinished={() => setPhase('playResults')} />
    );
  }

  if (phase === 'playResults') {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-8">
          <PlayResults gameId={playGameId} actions={
            <Button onClick={backToSetup}>{listId == null ? <><ShuffleIcon />New game</> : <><RotateCcwIcon />Play again</>}</Button>
          } />
        </div>
      </div>
    );
  }

  if (phase === 'answers') {
    const playedQuestions = questions.slice(0, playedCount);
    const allRevealed = revealedIndexes.size === playedQuestions.length;
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-5 px-6 py-8">
          <div className="flex flex-wrap items-center gap-3">
            <div>
              <h1 className="text-2xl font-semibold">Answers</h1>
              <p className="text-sm text-muted-foreground">{revealedIndexes.size} of {playedQuestions.length} revealed</p>
            </div>
            <div className="ml-auto flex gap-2">
              <Button onClick={revealNextAnswer} disabled={allRevealed}>
                <EyeIcon />Reveal next<Kbd className={KEY_HINT_ON_PRIMARY_BUTTON}>Space</Kbd>
              </Button>
              <Button variant="outline" onClick={backToSetup}>
                {listId == null ? <><ShuffleIcon />New game</> : <><RotateCcwIcon />Play again</>}
              </Button>
            </div>
          </div>
          {playedQuestions.length ? playedQuestions.map((question, index) => (
            <AnswerCard key={question.uid} question={question} number={index + 1} isRevealed={revealedIndexes.has(index)}
              onReveal={() => revealAnswer(index)} />
          )) : <p className="text-muted-foreground">No question was played: start a question's timer to include it.</p>}
        </div>
      </div>
    );
  }

  const wholeSecondsLeft = Math.ceil(secondsLeft);
  const isLastQuestion = currentIndex + 1 === questions.length;
  const timerIsFresh = secondsLeft === secondsPerQuestion && !timerEndsAt;
  const isWaitingBetweenQuestions = waitEndsAt != null;
  const isRunningOut = !isWaitingBetweenQuestions && wholeSecondsLeft <= WARNING_AT_SECONDS_LEFT;
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-4 border-b px-6 py-3">
        <span className="text-sm font-medium">Question {currentIndex + 1} of {questions.length}</span>
        <div className="flex gap-1" aria-hidden>
          {questions.map((question, index) => (
            <span key={question.uid}
              className={cn('h-1.5 w-6 rounded-full bg-muted', index < currentIndex && 'bg-foreground/40', index === currentIndex && 'bg-primary')} />
          ))}
        </div>
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => setIsConfirmingEnd(true)}><FlagIcon />End game</Button>
      </div>
      <Progress value={isWaitingBetweenQuestions ? (waitSecondsLeft / secondsBetweenQuestions) * 100 : (secondsLeft / secondsPerQuestion) * 100}
        className={cn('h-1 shrink-0 rounded-none', isRunningOut && '[&>[data-slot=progress-indicator]]:bg-amber-500')} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isWaitingBetweenQuestions ? (
          <NextQuestionNumber number={currentIndex + 1} total={questions.length} />
        ) : (
          <div className="mx-auto flex min-h-full max-w-5xl flex-col justify-center px-8 py-10">
            <QuestionOnScreen question={questions[currentIndex]} />
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-t px-6 py-3">
        {isWaitingBetweenQuestions ? <>
          <span className="min-w-24 text-4xl font-semibold text-muted-foreground tabular-nums">{formatClock(Math.ceil(waitSecondsLeft))}</span>
          <Button size="lg" onClick={() => showQuestion(currentIndex)}>
            <SkipForwardIcon />Skip wait<Kbd className={KEY_HINT_ON_PRIMARY_BUTTON}>Space</Kbd>
          </Button>
        </> : <>
        <span className={cn('min-w-24 text-4xl font-semibold tabular-nums', isRunningOut && 'text-amber-500',
          wholeSecondsLeft === 0 && 'text-destructive')}>
          {formatClock(wholeSecondsLeft)}
        </span>
        {timerEndsAt ? (
          <Button size="lg" onClick={pauseTimer}><PauseIcon />Pause<Kbd className={KEY_HINT_ON_PRIMARY_BUTTON}>Space</Kbd></Button>
        ) : (
          <Button size="lg" onClick={startTimer}>
            <PlayIcon />{timerIsFresh ? 'Start timer' : 'Resume'}<Kbd className={KEY_HINT_ON_PRIMARY_BUTTON}>Space</Kbd>
          </Button>
        )}
        <Button size="lg" variant="outline" onClick={resetTimer} disabled={timerIsFresh}><RotateCcwIcon />Reset</Button>
        <Button size="lg" variant="outline" className="ml-auto" onClick={() => goToNextQuestion()}>
          {isLastQuestion ? <><FlagIcon />Finish</> : <>Next question<ArrowRightIcon /></>}
          <Kbd>→</Kbd>
        </Button>
        </>}
      </div>
      <AlertDialog open={isConfirmingEnd} onOpenChange={setIsConfirmingEnd}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>End the game now?</AlertDialogTitle>
            <AlertDialogDescription>
              {playedCount
                ? `You'll reveal the answers to the ${playedCount === 1 ? 'question' : `${playedCount} questions`} played.`
                : 'No question was played yet, so there are no answers to reveal.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep playing</AlertDialogCancel>
            <AlertDialogAction onClick={endGame}>End game</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
