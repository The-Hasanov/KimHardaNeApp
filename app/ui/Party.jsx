import { useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { cn } from 'cn';
import {
  AppWindowIcon, ArrowRightIcon, CastIcon, CheckIcon, ChevronDownIcon, CircleHelpIcon, DoorClosedIcon, EyeOffIcon, FlagIcon, GamepadIcon, PauseIcon, PlayIcon, QrCodeIcon,
  RotateCcwIcon, SkipForwardIcon, TrophyIcon, TvIcon, UserXIcon, UsersIcon, WifiOffIcon, XIcon,
} from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Kbd } from '@/components/ui/kbd';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  KEY_HINT_ON_PRIMARY_BUTTON, QuestionOnScreen, WARNING_AT_SECONDS_LEFT, formatClock, useCountdown, withLineBreaks,
} from './gameShared';
import { toast } from 'sonner';
import { CorrectAnswer } from './Play';
import { useNightMode } from './theme';

const { api } = window;
const PHASES_IN_ROUND = ['waiting', 'question', 'judging', 'reveal'];

const pointsLabel = points => (points > 0 ? `+${points}` : points < 0 ? `−${-points}` : '0');
const hostOf = url => url.replace(/^http:\/\//, '').replace(/\/$/, '');
const outcomeOf = answer => (answer.isCorrect ? 'correct' : answer.verdict === 'unsure' && !answer.decidedByHost ? 'unsure' : 'wrong');
const OUTCOMES = {
  correct: { label: 'Correct', Icon: CheckIcon, className: 'text-emerald-600 dark:text-emerald-400' },
  wrong: { label: 'Wrong', Icon: XIcon, className: 'text-destructive' },
  unsure: { label: 'Not sure', Icon: CircleHelpIcon, className: 'text-amber-600 dark:text-amber-400' },
};

function JoinQrCode({ url, className = 'size-64' }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).then(setSvg);
  }, [url]);
  return <div className={cn('rounded-xl bg-white p-3 [&>svg]:size-full', className)} dangerouslySetInnerHTML={{ __html: svg }} />;
}

function JoinCard({ urls }) {
  const [chosenUrl, setChosenUrl] = useState(urls[0]?.url);
  if (!chosenUrl) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-xl border p-6 text-center">
        <WifiOffIcon className="size-8 text-muted-foreground" />
        <p className="font-medium">No network connection found</p>
        <p className="text-sm text-muted-foreground">Connect this computer to Wi-Fi or a network cable, then close and reopen the party.</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border p-6 text-center">
      <JoinQrCode url={chosenUrl} />
      <p className="text-sm text-muted-foreground">Scan with a phone camera, or open</p>
      <p className="font-mono text-xl font-semibold">{hostOf(chosenUrl)}</p>
      {urls.length > 1 && (
        <Select value={chosenUrl} onValueChange={setChosenUrl}>
          <SelectTrigger size="sm" className="w-72"><SelectValue /></SelectTrigger>
          <SelectContent position="popper">
            {urls.map(({ adapter, url }) => <SelectItem key={url} value={url}>{adapter} · {hostOf(url)}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
      <p className="max-w-sm text-xs text-muted-foreground">
        Phones must be on the same Wi-Fi as this computer. If the page does not open, allow KimHardaNeApp on private
        networks when Windows Firewall asks.
      </p>
    </div>
  );
}

function Leaderboard({ entries, showsRoundScore = false }) {
  if (!entries.length) return <p className="text-sm text-muted-foreground">No players yet.</p>;
  return (
    <ol className="space-y-1.5">
      {entries.map(entry => (
        <li key={entry.id} className={cn('flex items-center gap-3 rounded-lg bg-muted/50 px-3 py-2', entry.rank === 1 && 'bg-amber-500/15')}>
          <span className="w-6 text-right font-semibold text-muted-foreground tabular-nums">{entry.rank}</span>
          <span className="min-w-0 flex-1 truncate font-medium">{entry.name}</span>
          {showsRoundScore && <span className="text-xs text-muted-foreground tabular-nums">{pointsLabel(entry.roundScore)} this round</span>}
          <span className="w-10 text-right text-lg font-semibold tabular-nums">{entry.score}</span>
        </li>
      ))}
    </ol>
  );
}

function PlayerAnswers({ party }) {
  const answeredIds = new Set(party.answers.map(answer => answer.playerId));
  const silentPlayers = party.players.filter(player => !answeredIds.has(player.id));
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-medium text-muted-foreground">Answers</h2>
      <ul className="divide-y rounded-lg border">
        {party.answers.map(answer => {
          const { label, Icon, className } = OUTCOMES[outcomeOf(answer)];
          return (
            <li key={answer.playerId} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
              <span className="w-32 truncate font-medium">{answer.name}</span>
              <span className="min-w-0 flex-1 truncate">{answer.given || '—'}</span>
              <span className={cn('flex items-center gap-1 text-sm font-semibold', className)}><Icon className="size-4" />{label}</span>
              <span className="w-8 text-right text-sm tabular-nums">{pointsLabel(answer.points)}</span>
              <div className="flex gap-1">
                <Button size="icon-sm" variant={answer.isCorrect ? 'default' : 'outline'} aria-label={`Mark ${answer.name} correct`}
                  onClick={() => api.partySetCorrect(answer.playerId, party.index, true)}><CheckIcon /></Button>
                <Button size="icon-sm" variant={!answer.isCorrect && outcomeOf(answer) === 'wrong' ? 'default' : 'outline'}
                  aria-label={`Mark ${answer.name} wrong`} onClick={() => api.partySetCorrect(answer.playerId, party.index, false)}><XIcon /></Button>
              </div>
            </li>
          );
        })}
        {!party.answers.length && <li className="px-4 py-3 text-sm text-muted-foreground">Nobody answered.</li>}
      </ul>
      {silentPlayers.length > 0 && party.answers.length > 0 && (
        <p className="text-sm text-muted-foreground">No answer: {silentPlayers.map(player => player.name).join(', ')}</p>
      )}
    </div>
  );
}

function QuestionForHost({ party }) {
  const isUpNext = party.phase === 'waiting';
  return (
    <div className="mx-auto grid max-w-6xl gap-8 px-8 py-8 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-6">
        <p className="text-sm font-medium text-muted-foreground">
          {isUpNext ? `Up next · question ${party.index + 1} of ${party.total}` : `On the TV · question ${party.index + 1} of ${party.total}`}
        </p>
        <QuestionOnScreen question={party.question} textClassName="text-xl" imageClassName="max-h-64" />
        <div className="space-y-2 rounded-lg border border-dashed p-4">
          <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground"><EyeOffIcon className="size-3.5" />Answer · only you see this</p>
          <CorrectAnswer question={party.question} />
        </div>
      </div>
      <div className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Players</h2>
        <ul className="space-y-1.5">
          {party.players.map(player => (
            <li key={player.id} className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2">
              <span className="min-w-0 flex-1 truncate">{player.name}</span>
              {player.hasAnswered && <CheckIcon className="size-4 text-emerald-600 dark:text-emerald-400" aria-label="Answered" />}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const withoutIpcPrefix = error => error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function SamsungTvDialog({ isOpen, onOpenChange }) {
  const [tvs, setTvs] = useState(null);
  const [castingTo, setCastingTo] = useState(null);
  const searchForTvs = () => {
    setTvs(null);
    api.partyFindTvs().then(setTvs, () => setTvs([]));
  };
  useEffect(() => {
    if (isOpen) searchForTvs();
  }, [isOpen]);
  const castTo = async tv => {
    setCastingTo(tv.address);
    try {
      await api.partyCastSamsung(tv.address);
      toast.success(`Showing on ${tv.name}`, { description: 'Press OK on the TV remote for full screen. Sounds now play on the TV only.' });
      onOpenChange(false);
    } catch (error) {
      toast.error(withoutIpcPrefix(error));
    }
    setCastingTo(null);
  };
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Show on Samsung TV</DialogTitle>
          <DialogDescription>
            Samsung Smart TVs (2016 and newer) on the same network open the TV screen in their web browser. Nothing is
            installed on the TV.
          </DialogDescription>
        </DialogHeader>
        {tvs == null && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />Looking for Samsung TVs…</p>}
        {tvs?.length === 0 && (
          <p className="text-sm text-muted-foreground">No Samsung TV found. Turn the TV on and check that it is on the same network as this computer.</p>
        )}
        {tvs?.length > 0 && (
          <ul className="divide-y rounded-lg border">
            {tvs.map(tv => (
              <li key={tv.address} className="flex items-center gap-3 px-4 py-3">
                <TvIcon className="size-5 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{tv.name}</p>
                  <p className="text-xs text-muted-foreground">{tv.model} · {tv.address}</p>
                </div>
                <Button size="sm" disabled={castingTo != null} onClick={() => castTo(tv)}>
                  {castingTo === tv.address ? <Spinner /> : <CastIcon />}Show
                </Button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          The first time, the TV may ask to allow KimHardaNeApp: press Allow on the remote. The TV follows night mode.
        </p>
        <DialogFooter>
          <Button variant="outline" disabled={tvs == null} onClick={searchForTvs}>Search again</Button>
          <DialogClose asChild><Button>Done</Button></DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TvMenu() {
  const [castMethod, setCastMethod] = useState(null);
  const closeCastGuide = isOpen => !isOpen && setCastMethod(null);
  const castWithMiracast = () => {
    setCastMethod('miracast');
    api.partyCastMiracast();
  };
  const extendToTv = () => api.partyExtendDisplay().catch(() => toast.error('Windows did not switch to Extend. Press Win+P and choose Extend.'));
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm"><TvIcon />TV<ChevronDownIcon /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuItem onSelect={() => api.partyOpenDisplay()}><AppWindowIcon />Show TV window</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setCastMethod('samsung')}><CastIcon />Show on Samsung TV…</DropdownMenuItem>
          <DropdownMenuItem onSelect={castWithMiracast}><CastIcon />Cast with Miracast…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <SamsungTvDialog isOpen={castMethod === 'samsung'} onOpenChange={closeCastGuide} />

      <Dialog open={castMethod === 'miracast'} onOpenChange={closeCastGuide}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Cast with Miracast</DialogTitle>
            <DialogDescription>For TVs with Screen Mirroring (most Samsung, LG and Android TVs) or a Miracast adapter.</DialogDescription>
          </DialogHeader>
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>In the Windows <b>Cast</b> panel that just opened, pick your TV. Closed it? Press <Kbd>Win</Kbd> + <Kbd>K</Kbd>.</li>
            <li>Click <b>Extend to TV</b>. Never use Duplicate: the TV would copy this screen, answers included.</li>
            <li>The TV window moves to the TV by itself. Press <Kbd>F11</Kbd> in it for full screen.</li>
          </ol>
          <p className="text-xs text-muted-foreground">
            If Windows says this computer doesn't support Miracast (no Wi-Fi), use Show on Samsung TV or an HDMI cable.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => api.partyCastMiracast()}><CastIcon />Open Cast panel</Button>
            <Button onClick={extendToTv}><TvIcon />Extend to TV</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function PlayersInLobby({ players }) {
  return (
    <div className="space-y-3">
      <h2 className="flex items-center gap-2 font-medium"><UsersIcon className="size-4" />Players <Badge variant="secondary">{players.length}</Badge></h2>
      {players.length ? (
        <ul className="flex flex-wrap gap-2">
          {players.map(player => (
            <li key={player.id} className="flex items-center gap-1 rounded-full border py-1 pr-1 pl-3 text-sm animate-in fade-in-0 zoom-in-95">
              {player.name}
              <Button size="icon-xs" variant="ghost" aria-label={`Remove ${player.name}`} onClick={() => api.partyKick(player.id)}><UserXIcon /></Button>
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-muted-foreground">Waiting for players to scan the code…</p>}
    </div>
  );
}

export default function PartyScreen({ party, isVisible, lobbySettings, onBackToLobby, onClose }) {
  const [isConfirmingClose, setIsConfirmingClose] = useState(false);
  const handleKeyDown = useRef(null);
  const deadline = useMemo(() => (party.remainingMs == null || party.isPaused ? null : Date.now() + party.remainingMs), [party]);
  const countdownSeconds = useCountdown(deadline, () => {});
  const secondsLeft = party.isPaused ? party.remainingMs / 1000 : countdownSeconds;
  const wholeSecondsLeft = Math.ceil(secondsLeft);
  const isRunningOut = party.phase === 'question' && wholeSecondsLeft <= WARNING_AT_SECONDS_LEFT;
  const hasRunningClock = ['waiting', 'question'].includes(party.phase) || (party.phase === 'reveal' && party.remainingMs != null);

  const nightMode = useNightMode();
  useEffect(() => {
    api.partySetNightMode(nightMode);
  }, [nightMode, party.id]);

  handleKeyDown.current = e => {
    if (!isVisible || e.target.closest?.('input, textarea, [role=dialog], [role=alertdialog], [role=listbox]')) return;
    if (party.phase === 'waiting' && [' ', 'ArrowRight'].includes(e.key)) api.partySkipWait();
    else if (hasRunningClock && party.phase !== 'waiting' && e.key === ' ') (party.isPaused ? api.partyResume : api.partyPause)();
    else if (party.phase === 'reveal' && ['Enter', 'ArrowRight'].includes(e.key)) api.partyNext();
    else return;
    e.preventDefault();
  };
  useEffect(() => {
    const listener = e => handleKeyDown.current(e);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  const isInRound = PHASES_IN_ROUND.includes(party.phase);
  const answeredCount = party.players.filter(player => player.hasAnswered).length;
  const isLastQuestion = party.index + 1 === party.total;
  const secondsOfPhase = { waiting: party.rules.secondsBetweenQuestions, question: party.rules.secondsPerQuestion, reveal: party.rules.secondsOnAnswer };
  const timerPercent = hasRunningClock ? (secondsLeft / secondsOfPhase[party.phase]) * 100 : 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-6 py-3">
        <span className="flex items-center gap-2 text-sm font-medium"><UsersIcon className="size-4" />Party</span>
        {isInRound && <span className="text-sm">Round {party.round} · Question {party.index + 1} of {party.total}</span>}
        <span className="text-sm text-muted-foreground">{party.players.length} {party.players.length === 1 ? 'player' : 'players'}</span>
        {party.urls[0] && isInRound && <span className="font-mono text-sm text-muted-foreground">Join: {hostOf(party.urls[0].url)}</span>}
        <div className="ml-auto flex gap-2">
          {isInRound && <Button variant="outline" size="sm" onClick={() => api.partyFinishRound()}><FlagIcon />End round</Button>}
          <ToggleGroup type="single" variant="outline" size="sm" spacing={0} value={party.screen} aria-label="What the TV shows"
            onValueChange={screen => screen && api.partySetScreen(screen)}>
            <ToggleGroupItem value="game" className="px-2.5 aria-checked:bg-muted" title="The TV follows the game"><GamepadIcon />Game</ToggleGroupItem>
            <ToggleGroupItem value="leaderboard" className="px-2.5 aria-checked:bg-muted" title="Show the leaderboard on the TV"><TrophyIcon />Leaderboard</ToggleGroupItem>
            <ToggleGroupItem value="join" className="px-2.5 aria-checked:bg-muted" title="Show the join QR code on the TV"><QrCodeIcon />Join code</ToggleGroupItem>
          </ToggleGroup>
          <TvMenu />
          <Button variant="outline" size="sm" onClick={() => setIsConfirmingClose(true)}><DoorClosedIcon />Close party</Button>
        </div>
      </div>
      {isInRound && (
        <Progress value={timerPercent} className={cn('h-1 shrink-0 rounded-none', isRunningOut && '[&>[data-slot=progress-indicator]]:bg-amber-500')} />
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {party.phase === 'lobby' && (
          <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
            <div className="grid gap-6 md:grid-cols-[auto_1fr]">
              <JoinCard urls={party.urls} />
              <div className="space-y-6">
                <PlayersInLobby players={party.players} />
                {party.round > 0 && (
                  <div className="space-y-2">
                    <h2 className="font-medium">Scores after round {party.round}</h2>
                    <Leaderboard entries={party.leaderboard} />
                  </div>
                )}
              </div>
            </div>
            {lobbySettings}
          </div>
        )}
        {['waiting', 'question', 'judging'].includes(party.phase) && <QuestionForHost party={party} />}
        {party.phase === 'reveal' && (
          <div className="mx-auto grid max-w-6xl gap-8 px-8 py-8 lg:grid-cols-[1fr_20rem]">
            <div className="space-y-6">
              <p className="line-clamp-3 whitespace-pre-line text-muted-foreground">{withLineBreaks(party.question.text)}</p>
              <CorrectAnswer question={party.question} />
              <PlayerAnswers party={party} />
            </div>
            <div className="space-y-2">
              <h2 className="text-sm font-medium text-muted-foreground">Leaderboard</h2>
              <Leaderboard entries={party.leaderboard} />
            </div>
          </div>
        )}
        {party.phase === 'finished' && (
          <div className="mx-auto max-w-2xl space-y-6 px-6 py-10">
            <div className="flex items-center gap-4">
              <TrophyIcon className="size-12 text-amber-500" />
              <div>
                <h1 className="text-3xl font-semibold">Round {party.round} results</h1>
                <p className="text-muted-foreground">Correct {pointsLabel(party.rules.pointsForCorrect)} · wrong {pointsLabel(party.rules.pointsForWrong)} · no answer 0</p>
              </div>
            </div>
            <Leaderboard entries={party.leaderboard} showsRoundScore />
            <div className="flex flex-wrap gap-2">
              <Button size="lg" onClick={() => onBackToLobby(true)}><ArrowRightIcon />Next round (keep scores)</Button>
              <Button size="lg" variant="outline" onClick={() => onBackToLobby(false)}><RotateCcwIcon />New game (reset scores)</Button>
            </div>
          </div>
        )}
      </div>

      {isInRound && (
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-t px-6 py-3">
          {hasRunningClock && (
            <span className={cn('min-w-24 text-4xl font-semibold tabular-nums', party.phase !== 'question' && 'text-muted-foreground',
              isRunningOut && 'text-amber-500')}>{formatClock(wholeSecondsLeft)}</span>
          )}
          {party.phase === 'reveal' && hasRunningClock && <span className="text-lg text-muted-foreground">until {isLastQuestion ? 'the round results' : 'the next question'} (autoplay)</span>}
          {party.phase === 'waiting' && (
            <Button size="lg" onClick={() => api.partySkipWait()}><SkipForwardIcon />Skip wait<Kbd className={KEY_HINT_ON_PRIMARY_BUTTON}>Space</Kbd></Button>
          )}
          {hasRunningClock && (
            party.isPaused
              ? <Button size="lg" variant="outline" onClick={() => api.partyResume()}><PlayIcon />Resume{party.phase !== 'waiting' && <Kbd>Space</Kbd>}</Button>
              : <Button size="lg" variant="outline" onClick={() => api.partyPause()}><PauseIcon />Pause{party.phase !== 'waiting' && <Kbd>Space</Kbd>}</Button>
          )}
          {party.phase === 'question' && <>
            <span className="text-lg"><span className="font-semibold tabular-nums">{answeredCount}</span> of {party.players.length} answered</span>
            <Button size="lg" variant="outline" className="ml-auto" onClick={() => api.partyCloseAnswers()}>Close answers now</Button>
          </>}
          {party.phase === 'judging' && <span className="flex items-center gap-2 text-lg"><Spinner />Checking answers…</span>}
          {party.phase === 'reveal' && (
            <Button size="lg" className="ml-auto" onClick={() => api.partyNext()}>
              {isLastQuestion ? <><TrophyIcon />Round results</> : <>Next question<ArrowRightIcon /></>}
              <Kbd className={KEY_HINT_ON_PRIMARY_BUTTON}>Enter</Kbd>
            </Button>
          )}
        </div>
      )}

      <AlertDialog open={isConfirmingClose} onOpenChange={setIsConfirmingClose}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close the party?</AlertDialogTitle>
            <AlertDialogDescription>All players are disconnected and the scores are cleared.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep playing</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onClose}>Close party</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
