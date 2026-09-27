import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { cn } from 'cn';
import {
  ArrowRightIcon, CheckIcon, CircleHelpIcon, FlagIcon, HistoryIcon, SendIcon, SkipForwardIcon, Trash2Icon, TrophyIcon, XIcon,
} from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import {
  KEY_HINT_ON_PRIMARY_BUTTON, NextQuestionNumber, QuestionOnScreen, WARNING_AT_SECONDS_LEFT, formatClock, playTenSecondsLeftTone,
  playTimeUpTone, useCountdown, withLineBreaks,
} from './gameShared';

const { api } = window;

const OUTCOMES = {
  correct: { label: 'Correct', Icon: CheckIcon, textClass: 'text-emerald-600 dark:text-emerald-400', dotClass: 'bg-emerald-500' },
  wrong: { label: 'Wrong', Icon: XIcon, textClass: 'text-destructive', dotClass: 'bg-destructive' },
  unsure: { label: 'Not sure', Icon: CircleHelpIcon, textClass: 'text-amber-600 dark:text-amber-400', dotClass: 'bg-amber-500' },
};

const outcomeOf = answer => (answer.is_correct ? 'correct' : answer.ai_verdict === 'unsure' && !answer.decided_by_player ? 'unsure' : 'wrong');
const localDateTime = sqliteUtc => new Date(`${sqliteUtc.replace(' ', 'T')}Z`).toLocaleString();

function checkerNote(answer) {
  if (!answer.given_answer.trim()) return 'No answer given.';
  if (answer.similarity === 1) return `Matches “${answer.closest_answer}”.`;
  if (answer.similarity == null) return 'Does not match the answer.';
  const note = `AI: ${Math.round(answer.similarity * 100)}% similar to “${answer.closest_answer}”.`;
  return outcomeOf(answer) === 'unsure' ? `${note} Mark it yourself.` : note;
}

function CorrectnessButtons({ answer, onChange, size = 'sm' }) {
  return (
    <div className="flex gap-1.5">
      <Button size={size} variant={answer.is_correct ? 'default' : 'outline'} onClick={() => onChange(true)}><CheckIcon />Correct</Button>
      <Button size={size} variant={!answer.is_correct && outcomeOf(answer) === 'wrong' ? 'default' : 'outline'} onClick={() => onChange(false)}>
        <XIcon />Wrong
      </Button>
    </div>
  );
}

function OutcomeLabel({ answer, className }) {
  const { label, Icon, textClass } = OUTCOMES[outcomeOf(answer)];
  return <span className={cn('flex items-center gap-1.5 font-semibold', textClass, className)}><Icon className="size-[1em]" />{label}</span>;
}

export function CorrectAnswer({ question }) {
  return (
    <div className="space-y-2">
      <p className="text-2xl font-semibold">{question.answer}</p>
      {question.accepted_answers && <p className="text-sm"><span className="text-muted-foreground">Also accepted: </span>{question.accepted_answers}</p>}
      {question.comment && <p className="text-sm whitespace-pre-line text-muted-foreground">{question.comment}</p>}
      {question.source_media_src && <img src={question.source_media_src} alt="Answer" className="max-h-72 rounded-lg border object-contain" />}
    </div>
  );
}

export function PlayRound({ gameId, questions, secondsPerQuestion, secondsBetweenQuestions, isVisible, onFinished }) {
  const [index, setIndex] = useState(0);
  const [stage, setStage] = useState('waiting');
  const [givenAnswer, setGivenAnswer] = useState('');
  const [answers, setAnswers] = useState({});
  const [timerEndsAt, setTimerEndsAt] = useState(null);
  const [waitEndsAt, setWaitEndsAt] = useState(null);
  const [isConfirmingEnd, setIsConfirmingEnd] = useState(false);
  const questionShownAt = useRef(0);
  const warningPlayed = useRef(false);
  const submittedPosition = useRef(-1);
  const verdictPanel = useRef(null);
  const handleKeyDown = useRef(null);

  const showQuestion = () => {
    setWaitEndsAt(null);
    setStage('answering');
    warningPlayed.current = false;
    questionShownAt.current = Date.now();
    setTimerEndsAt(Date.now() + secondsPerQuestion * 1000);
  };
  const goTo = position => {
    setIndex(position);
    setGivenAnswer('');
    if (!secondsBetweenQuestions) return showQuestion();
    setStage('waiting');
    setWaitEndsAt(Date.now() + secondsBetweenQuestions * 1000);
  };
  useEffect(() => { goTo(0); }, []);

  const submit = async () => {
    if (stage !== 'answering' || submittedPosition.current === index) return;
    submittedPosition.current = index;
    setTimerEndsAt(null);
    setStage('judging');
    const position = index;
    try {
      const saved = await api.submitPlayAnswer(gameId, {
        position, uid: questions[position].uid, givenAnswer: givenAnswer.trim(), secondsUsed: (Date.now() - questionShownAt.current) / 1000,
      });
      setAnswers(all => ({ ...all, [position]: saved }));
    } catch (e) {
      toast.error('Could not check the answer', { description: e.message });
    }
    setStage('judged');
    requestAnimationFrame(() => verdictPanel.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  };
  const setCorrect = (position, isCorrect) =>
    api.setPlayAnswerCorrect(gameId, position, isCorrect).then(saved => setAnswers(all => ({ ...all, [position]: saved })));
  const finish = async () => {
    setTimerEndsAt(null);
    setWaitEndsAt(null);
    setIsConfirmingEnd(false);
    await api.finishPlayGame(gameId);
    onFinished();
  };
  const next = () => (index + 1 >= questions.length ? finish() : goTo(index + 1));

  const waitSecondsLeft = useCountdown(waitEndsAt, showQuestion);
  const secondsLeft = useCountdown(timerEndsAt, () => {
    playTimeUpTone();
    submit();
  });
  useEffect(() => {
    if (!timerEndsAt || secondsLeft <= 0 || secondsLeft > WARNING_AT_SECONDS_LEFT || warningPlayed.current) return;
    warningPlayed.current = true;
    playTenSecondsLeftTone();
  }, [secondsLeft]);

  handleKeyDown.current = e => {
    if (!isVisible || e.target.closest?.('[role=dialog], [role=alertdialog]')) return;
    if (stage === 'waiting' && [' ', 'Enter', 'ArrowRight'].includes(e.key)) showQuestion();
    else if (stage === 'judged' && ['Enter', 'ArrowRight'].includes(e.key)) next();
    else return;
    e.preventDefault();
  };
  useEffect(() => {
    const listener = e => handleKeyDown.current(e);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  const question = questions[index];
  const answer = answers[index];
  const score = Object.values(answers).filter(a => a.is_correct).length;
  const isWaiting = stage === 'waiting';
  const wholeSecondsLeft = Math.ceil(secondsLeft);
  const isRunningOut = stage === 'answering' && wholeSecondsLeft <= WARNING_AT_SECONDS_LEFT;
  const isLastQuestion = index + 1 === questions.length;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-4 border-b px-6 py-3">
        <span className="text-sm font-medium">Question {index + 1} of {questions.length}</span>
        <div className="flex gap-1" aria-hidden>
          {questions.map((q, position) => (
            <span key={q.uid} className={cn('h-1.5 w-6 rounded-full bg-muted',
              answers[position] ? OUTCOMES[outcomeOf(answers[position])].dotClass : position === index && 'bg-primary')} />
          ))}
        </div>
        <span className="text-sm text-muted-foreground">Score <span className="font-semibold text-foreground tabular-nums">{score}</span></span>
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => setIsConfirmingEnd(true)}><FlagIcon />End game</Button>
      </div>
      <Progress value={isWaiting ? (waitSecondsLeft / secondsBetweenQuestions) * 100 : (secondsLeft / secondsPerQuestion) * 100}
        className={cn('h-1 shrink-0 rounded-none', isRunningOut && '[&>[data-slot=progress-indicator]]:bg-amber-500')} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isWaiting ? <NextQuestionNumber number={index + 1} total={questions.length} /> : (
          <div className="mx-auto flex min-h-full max-w-5xl flex-col justify-center gap-8 px-8 py-10">
            <QuestionOnScreen question={question} />
            {stage === 'judged' && (
              <div ref={verdictPanel} className="space-y-4 rounded-lg border p-5 animate-in fade-in-0">
                {answer ? <>
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <OutcomeLabel answer={answer} className="text-2xl" />
                    <span className="text-sm text-muted-foreground">{checkerNote(answer)}</span>
                  </div>
                  <p><span className="text-muted-foreground">Your answer: </span>{answer.given_answer || '—'}</p>
                </> : <p className="text-muted-foreground">This answer could not be checked.</p>}
                <CorrectAnswer question={question} />
              </div>
            )}
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-t px-6 py-3">
        <span className={cn('min-w-24 text-4xl font-semibold tabular-nums', isWaiting && 'text-muted-foreground',
          isRunningOut && 'text-amber-500', stage === 'answering' && wholeSecondsLeft === 0 && 'text-destructive')}>
          {formatClock(isWaiting ? Math.ceil(waitSecondsLeft) : wholeSecondsLeft)}
        </span>
        {isWaiting && (
          <Button size="lg" onClick={showQuestion}><SkipForwardIcon />Skip wait<Kbd className={KEY_HINT_ON_PRIMARY_BUTTON}>Space</Kbd></Button>
        )}
        {(stage === 'answering' || stage === 'judging') && (
          <form className="flex flex-1 gap-2" onSubmit={e => { e.preventDefault(); submit(); }}>
            <Input value={givenAnswer} onChange={e => setGivenAnswer(e.target.value)} placeholder="Your answer" autoFocus
              disabled={stage === 'judging'} spellCheck={false} className="h-10 flex-1 text-lg md:text-lg" maxLength={200} />
            <Button type="submit" size="lg" disabled={stage === 'judging'}>
              {stage === 'judging' ? <Spinner /> : <SendIcon />}Answer<Kbd className={KEY_HINT_ON_PRIMARY_BUTTON}>Enter</Kbd>
            </Button>
          </form>
        )}
        {stage === 'judged' && <>
          {answer && <CorrectnessButtons answer={answer} size="lg" onChange={isCorrect => setCorrect(index, isCorrect)} />}
          <Button size="lg" className="ml-auto" onClick={next}>
            {isLastQuestion ? <><TrophyIcon />See results</> : <>Next question<ArrowRightIcon /></>}
            <Kbd className={KEY_HINT_ON_PRIMARY_BUTTON}>Enter</Kbd>
          </Button>
        </>}
      </div>
      <AlertDialog open={isConfirmingEnd} onOpenChange={setIsConfirmingEnd}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>End the game now?</AlertDialogTitle>
            <AlertDialogDescription>Your answers so far are saved with the score.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep playing</AlertDialogCancel>
            <AlertDialogAction onClick={finish}>End game</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function PlayResults({ gameId, actions }) {
  const [game, setGame] = useState(null);
  const [answers, setAnswers] = useState(null);
  useEffect(() => {
    api.playGames().then(games => setGame(games.find(g => g.id === gameId) ?? null));
    api.playGameAnswers(gameId).then(setAnswers);
  }, [gameId]);
  const setCorrect = (position, isCorrect) => api.setPlayAnswerCorrect(gameId, position, isCorrect).then(saved =>
    setAnswers(all => all.map(a => (a.position === position ? { ...a, ...saved } : a))));

  if (!game || !answers) return <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground"><Spinner />Loading results…</div>;
  const score = answers.filter(a => a.is_correct).length;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-4">
        <TrophyIcon className="size-10 text-amber-500" />
        <div>
          <p className="text-4xl font-semibold tabular-nums">{score} / {game.question_count}</p>
          <p className="text-sm text-muted-foreground">
            {game.title} · {localDateTime(game.started_at)} · {answers.length} answered{!game.finished_at && ' · unfinished'}
          </p>
        </div>
        <div className="ml-auto flex gap-2">{actions}</div>
      </div>
      {answers.map(answer => (
        <div key={answer.position} className="space-y-3 rounded-lg border p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">Question {answer.position + 1}</Badge>
            <OutcomeLabel answer={answer} className="text-sm" />
            <span className="text-xs text-muted-foreground">{checkerNote(answer)}</span>
            <div className="ml-auto"><CorrectnessButtons answer={answer} onChange={isCorrect => setCorrect(answer.position, isCorrect)} /></div>
          </div>
          {answer.question && <p className="line-clamp-3 text-sm whitespace-pre-line text-muted-foreground">{withLineBreaks(answer.question.text)}</p>}
          <div className="grid gap-1 text-sm sm:grid-cols-2">
            <p><span className="text-muted-foreground">Your answer: </span>{answer.given_answer || '—'}</p>
            <p><span className="text-muted-foreground">Answer: </span><span className="font-semibold">{answer.question?.answer ?? '?'}</span></p>
          </div>
        </div>
      ))}
    </div>
  );
}

export function PlayHistory({ isVisible }) {
  const [games, setGames] = useState([]);
  const [openGameId, setOpenGameId] = useState(null);
  const refresh = () => api.playGames().then(setGames);
  useEffect(() => { if (isVisible) refresh(); }, [isVisible]);
  const deleteGame = async () => {
    await api.deletePlayGame(openGameId);
    setOpenGameId(null);
    refresh();
  };

  if (!games.length) return null;
  return (
    <div className="space-y-2">
      <h2 className="flex items-center gap-2 text-sm font-medium"><HistoryIcon className="size-4" />Your results</h2>
      <ol className="divide-y rounded-lg border">
        {games.map(game => (
          <li key={game.id}>
            <button type="button" onClick={() => setOpenGameId(game.id)}
              className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors hover:bg-muted/60">
              <span className="w-16 font-semibold tabular-nums">{game.score} / {game.question_count}</span>
              <span className="flex-1 truncate">{game.title}</span>
              {!game.finished_at && <Badge variant="outline">unfinished</Badge>}
              <span className="text-xs text-muted-foreground">{localDateTime(game.started_at)}</span>
            </button>
          </li>
        ))}
      </ol>
      <Dialog open={openGameId != null} onOpenChange={isOpen => { if (!isOpen) { setOpenGameId(null); refresh(); } }}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-3xl" aria-describedby={undefined}>
          <DialogTitle className="sr-only">Game results</DialogTitle>
          {openGameId != null && (
            <PlayResults gameId={openGameId}
              actions={<Button variant="outline" onClick={deleteGame}><Trash2Icon />Delete</Button>} />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
