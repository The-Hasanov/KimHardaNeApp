import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { cn } from 'cn';
import {
  ArrowRightIcon, EyeIcon, FlagIcon, Gamepad2Icon, ImageIcon, PauseIcon, PlayIcon, PresentationIcon, RotateCcwIcon, SettingsIcon,
  ShuffleIcon, SkipForwardIcon, SparklesIcon, UsersIcon,
} from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  KEY_HINT_ON_PRIMARY_BUTTON, NextQuestionNumber, QuestionOnScreen, WARNING_AT_SECONDS_LEFT, formatClock, playTenSecondsLeftTone,
  playTimeUpTone, withLineBreaks,
} from './gameShared';
import PartyScreen from './Party';
import { PlayHistory, PlayResults, PlayRound } from './Play';

const { api } = window;
const QUESTIONS_PER_GAME = 10;
const DEFAULT_SECONDS_PER_QUESTION = 60;
const RANDOM_SOURCE = 'random';
const MAX_SECONDS_BETWEEN_QUESTIONS = 120;
const DEFAULT_SECONDS_ON_ANSWER = 10;
const RANDOM_GAME_TITLE = 'Random · Nə? Harada? Nə zaman?';

function NumberField({ id, label, value, min, max, step = 1, onChange }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const isAllowed = number => Number.isFinite(number) && number >= min && number <= max;
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="number" min={min} max={max} step={step} value={draft} className="w-28"
        onChange={e => {
          setDraft(e.target.value);
          const number = Math.round(Number(e.target.value));
          if (e.target.value.trim() !== '' && isAllowed(number)) onChange(number);
        }}
        onBlur={() => setDraft(String(value))} />
    </div>
  );
}

const MODE_DESCRIPTIONS = {
  host: summary => `Host mode: ${summary} and a timer. Answers stay hidden until you end the game.`,
  play: summary => `Play mode: answer ${summary} yourself against the clock. AI search checks each answer, and you can overrule it.`,
  party: summary => `Party mode: players join from their phones by scanning a QR code, then answer ${summary} on their own screens. AI search checks the answers; scores add up over rounds.`,
};
const TIMING_HELP = {
  host: "Between questions the next question's number fills the screen; Space skips the wait. Auto-start starts each question's timer as soon as the question appears.",
  play: "Between questions the next question's number fills the screen; Space skips the wait. Each question's timer starts as soon as it appears.",
  party: "Between questions the next question's number fills every screen. Autoplay moves on to the next question once the answer has been shown for that many seconds; Pause holds it. A blank answer scores 0; a wrong one scores the points for a wrong answer (use a negative number as a penalty).",
};

function RoundSettings({ mode, questions, lists, listId, onListIdChange, onNewSet, settings, onSettingsChange, action }) {
  const chosenList = lists.find(list => list.id === listId);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-2">
          <Label>Questions</Label>
          <Select value={listId == null ? RANDOM_SOURCE : String(listId)}
            onValueChange={value => onListIdChange(value === RANDOM_SOURCE ? null : Number(value))}>
            <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value={RANDOM_SOURCE}>{QUESTIONS_PER_GAME} random · Nə? Harada? Nə zaman?</SelectItem>
              {lists.length > 0 && <SelectSeparator />}
              {lists.map(list => (
                <SelectItem key={list.id} value={String(list.id)} disabled={!list.count}>
                  {list.name}<span className="text-muted-foreground tabular-nums">{list.count}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {!chosenList && <Button variant="outline" onClick={onNewSet} disabled={!questions}><ShuffleIcon />New set</Button>}
        <div className="ml-auto">{action}</div>
      </div>
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
        {mode === 'party' && <>
          <div className="flex h-8 items-center gap-2">
            <Switch id="autoplay" checked={settings.isAutoplay} onCheckedChange={isAutoplay => onSettingsChange({ isAutoplay })} />
            <Label htmlFor="autoplay" className="font-normal">Autoplay</Label>
          </div>
          {settings.isAutoplay && (
            <NumberField id="seconds-on-answer" label="Seconds on the answer" value={settings.secondsOnAnswer} min={3} max={120} step={5}
              onChange={secondsOnAnswer => onSettingsChange({ secondsOnAnswer })} />
          )}
          <NumberField id="points-for-correct" label="Points for correct" value={settings.pointsForCorrect} min={1} max={10}
            onChange={pointsForCorrect => onSettingsChange({ pointsForCorrect })} />
          <NumberField id="points-for-wrong" label="Points for wrong" value={settings.pointsForWrong} min={-10} max={0}
            onChange={pointsForWrong => onSettingsChange({ pointsForWrong })} />
        </>}
        <p className="basis-full text-xs text-muted-foreground">{TIMING_HELP[mode]}</p>
      </div>
    </div>
  );
}

function GameSetup({ mode, onModeChange, isAiReady, onOpenSettings, onStart, ...roundSettings }) {
  const { questions, lists, listId } = roundSettings;
  const chosenList = lists.find(list => list.id === listId);
  const needsAi = mode !== 'host';
  const questionsSummary = chosenList ? `the ${questions?.length ?? chosenList.count} questions of this list` : `${QUESTIONS_PER_GAME} random questions`;
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-6 py-8">
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          <h1 className="text-2xl font-semibold">{chosenList ? chosenList.name : 'Nə? Harada? Nə zaman?'}</h1>
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
          <span className="flex-1">{mode === 'party' ? 'Party' : 'Play'} mode checks answers with AI search. Turn it on in Settings first.</span>
          <Button size="sm" variant="outline" onClick={onOpenSettings}><SettingsIcon />Open Settings</Button>
        </div>
      )}
      <RoundSettings mode={mode} {...roundSettings} action={
        <Button size="lg" onClick={onStart} disabled={!questions?.length || (needsAi && !isAiReady)}>
          {mode === 'party' ? <><UsersIcon />Open party</> : <><PlayIcon />Start game</>}
        </Button>
      } />
      {!questions ? (
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
          {question.source_media_src && <img src={question.source_media_src} alt="Answer" className="max-h-72 rounded-lg border object-contain" />}
        </div>
      ) : <div className="h-8 rounded-md bg-muted" aria-label="Answer hidden" />}
    </div>
  );
}

export default function Game({ isVisible, lists, listId, onListIdChange, isAiReady, onOpenSettings }) {
  const [mode, setMode] = useState(() => localStorage.getItem('gameMode') ?? 'host');
  const [playGameId, setPlayGameId] = useState(null);
  const [phase, setPhase] = useState('setup');
  const [questions, setQuestions] = useState(null);
  const [secondsPerQuestion, setSecondsPerQuestion] = useState(DEFAULT_SECONDS_PER_QUESTION);
  const [secondsBetweenQuestions, setSecondsBetweenQuestions] = useState(0);
  const [shouldAutoStartTimer, setShouldAutoStartTimer] = useState(false);
  const [pointsForCorrect, setPointsForCorrect] = useState(1);
  const [pointsForWrong, setPointsForWrong] = useState(0);
  const [isAutoplay, setIsAutoplay] = useState(false);
  const [secondsOnAnswer, setSecondsOnAnswer] = useState(DEFAULT_SECONDS_ON_ANSWER);
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

  const pickQuestions = () => {
    setQuestions(null);
    listIdOfQuestions.current = listId;
    const loading = listId == null ? api.gameQuestions(QUESTIONS_PER_GAME) : api.listQuestions(listId);
    loading.then(setQuestions, e => toast.error('Could not load questions', { description: e.message }));
  };
  useEffect(() => {
    if (!isVisible || !['setup', 'party'].includes(phase)) return;
    if (listId != null || !questions || listIdOfQuestions.current !== listId) pickQuestions();
  }, [isVisible, listId]);

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
  const roundSettingsValues = { secondsPerQuestion, secondsBetweenQuestions, shouldAutoStartTimer, pointsForCorrect, pointsForWrong, isAutoplay, secondsOnAnswer };
  const changeRoundSettings = changes => {
    if ('secondsPerQuestion' in changes) {
      setSecondsPerQuestion(changes.secondsPerQuestion);
      setSecondsLeft(changes.secondsPerQuestion);
    }
    if ('secondsBetweenQuestions' in changes) setSecondsBetweenQuestions(changes.secondsBetweenQuestions);
    if ('shouldAutoStartTimer' in changes) setShouldAutoStartTimer(changes.shouldAutoStartTimer);
    if ('pointsForCorrect' in changes) setPointsForCorrect(changes.pointsForCorrect);
    if ('pointsForWrong' in changes) setPointsForWrong(changes.pointsForWrong);
    if ('isAutoplay' in changes) setIsAutoplay(changes.isAutoplay);
    if ('secondsOnAnswer' in changes) setSecondsOnAnswer(changes.secondsOnAnswer);
  };
  const roundSettingsProps = {
    questions, lists, listId, onListIdChange, onNewSet: pickQuestions, settings: roundSettingsValues, onSettingsChange: changeRoundSettings,
  };
  useEffect(() => { api.onParty(setPartyState); }, []);
  const openParty = async () => {
    try {
      setPartyState(await api.partyOpen());
      setPhase('party');
    } catch (e) {
      toast.error('Could not open the party', { description: e.message });
    }
  };
  const startPartyRound = () => api.partyStartRound({
    uids: questions.map(question => question.uid), secondsPerQuestion, secondsBetweenQuestions, pointsForCorrect, pointsForWrong,
    secondsOnAnswer: isAutoplay ? secondsOnAnswer : 0,
  });
  const partyBackToLobby = async keepScores => {
    await api.partyBackToLobby(keepScores);
    pickQuestions();
  };
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
      <div className="h-full overflow-y-auto">
        <GameSetup mode={mode} onModeChange={changeMode} isAiReady={isAiReady} onOpenSettings={onOpenSettings} onStart={startGame}
          {...roundSettingsProps} />
      </div>
    );
  }

  if (phase === 'party' && partyState) {
    return (
      <PartyScreen party={partyState} isVisible={isVisible} onBackToLobby={partyBackToLobby} onClose={closeParty}
        lobbySettings={
          <RoundSettings mode="party" {...roundSettingsProps} action={
            <Button size="lg" onClick={startPartyRound} disabled={!questions?.length || !partyState.players.length}>
              <PlayIcon />Start round {partyState.round + 1}
            </Button>
          } />
        } />
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
