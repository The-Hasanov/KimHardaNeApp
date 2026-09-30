import { useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { cn } from 'cn';
import {
  AppWindowIcon, ArrowRightIcon, CastIcon, MegaphoneIcon, SendIcon, CheckIcon, ChevronDownIcon, CircleHelpIcon, DoorClosedIcon, EyeIcon, EyeOffIcon, FlagIcon, GamepadIcon, PauseIcon, PlayIcon, QrCodeIcon,
  RotateCcwIcon, SkipForwardIcon, Trash2Icon, TriangleAlertIcon, TrophyIcon, TvIcon, UserXIcon, UsersIcon, WifiOffIcon, XIcon,
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
import { Textarea } from '@/components/ui/textarea';
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
const isWaitingToReveal = party => party.phase === 'judging' && party.rules.revealAtEnd && party.answers.every(answer => answer.isCorrect !== undefined);
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

function OnlineDot({ isOnline }) {
  return (
    <span className={cn('size-2 shrink-0 rounded-full', isOnline ? 'bg-emerald-500' : 'bg-muted-foreground/40')}
      title={isOnline ? 'Online' : 'Offline'} aria-label={isOnline ? 'Online' : 'Offline'} />
  );
}

function AwayWarning({ timesAway }) {
  if (!timesAway) return null;
  const label = `Left the game screen ${timesAway === 1 ? 'once' : `${timesAway} times`} during this question`;
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5 text-amber-600 dark:text-amber-400" title={label} aria-label={label}>
      <TriangleAlertIcon className="size-4" />
      {timesAway > 1 && <span className="text-xs font-semibold tabular-nums">{timesAway}</span>}
    </span>
  );
}

function KickButton({ player, onKick }) {
  return (
    <Button size="icon-xs" variant="ghost" className="text-muted-foreground" aria-label={`Remove ${player.name}`} title={`Remove ${player.name} from the game`}
      onClick={() => onKick(player)}><UserXIcon /></Button>
  );
}

function Leaderboard({ entries, players = [], onKick, showsRoundScore = false }) {
  if (!entries.length) return <p className="text-sm text-muted-foreground">No players yet.</p>;
  const isOnline = new Map(players.map(player => [player.id, player.isOnline]));
  return (
    <ol className="space-y-1.5">
      {entries.map(entry => (
        <li key={entry.id} className={cn('flex items-center gap-3 rounded-lg bg-muted/50 px-3 py-2', entry.rank === 1 && 'bg-amber-500/15')}>
          <span className="w-6 text-right font-semibold text-muted-foreground tabular-nums">{entry.rank}</span>
          {onKick && <OnlineDot isOnline={isOnline.get(entry.id)} />}
          <span className="min-w-0 flex-1 truncate font-medium">{entry.name}</span>
          {showsRoundScore && <span className="text-xs text-muted-foreground tabular-nums">{pointsLabel(entry.roundScore)} this round</span>}
          <span className="w-10 text-right text-lg font-semibold tabular-nums">{entry.score}</span>
          {onKick && <KickButton player={entry} onKick={onKick} />}
        </li>
      ))}
    </ol>
  );
}

function AllTimeLeaderboard() {
  const [results, setResults] = useState(null);
  const [isConfirmingReset, setIsConfirmingReset] = useState(false);
  useEffect(() => {
    api.partyResults().then(setResults);
    return api.onPartyResults(setResults);
  }, []);
  const reset = async () => setResults(await api.resetPartyResults());
  if (!results) return null;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="flex items-center gap-2 font-medium"><TrophyIcon className="size-4" />All-time leaderboard</h2>
        {results.length > 0 && (
          <Button size="sm" variant="ghost" className="ml-auto text-muted-foreground" onClick={() => setIsConfirmingReset(true)}><Trash2Icon />Reset</Button>
        )}
      </div>
      {results.length ? (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr className="text-left">
                <th className="w-10 px-3 py-2 text-right font-medium">#</th>
                <th className="px-3 py-2 font-medium">Player</th>
                <th className="px-3 py-2 text-right font-medium">Correct</th>
                <th className="px-3 py-2 text-right font-medium">Wrong</th>
                <th className="px-3 py-2 text-right font-medium">No answer</th>
                <th className="px-3 py-2 text-right font-medium">Rounds</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {results.map((result, i) => (
                <tr key={result.name} className={cn(i === 0 && 'bg-amber-500/10')}>
                  <td className="px-3 py-2 text-right font-semibold text-muted-foreground tabular-nums">{i + 1}</td>
                  <td className="max-w-48 truncate px-3 py-2 font-medium">{result.name}</td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">{result.correct}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-destructive">{result.wrong}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{result.unanswered}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{result.rounds}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="text-sm text-muted-foreground">Every finished round adds each player's correct, wrong and unanswered questions here.</p>}
      <AlertDialog open={isConfirmingReset} onOpenChange={setIsConfirmingReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset the all-time leaderboard?</AlertDialogTitle>
            <AlertDialogDescription>Every saved party result is deleted. This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep results</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={reset}>Reset</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function CallButtons({ answer, position, isCalledNow = answer.isCorrect ?? answer.hostCall }) {
  return (
    <div className="flex gap-1">
      <Button size="icon-sm" variant="outline" aria-label={`Mark ${answer.name} correct`} aria-pressed={isCalledNow === true}
        className={cn(isCalledNow === true && 'border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-600/90 hover:text-white dark:border-emerald-500 dark:bg-emerald-500 dark:hover:bg-emerald-500/90')}
        onClick={() => api.partySetCorrect(answer.playerId, position, true)}><CheckIcon /></Button>
      <Button size="icon-sm" variant="outline" aria-label={`Mark ${answer.name} wrong`} aria-pressed={isCalledNow === false}
        className={cn(isCalledNow === false && 'border-destructive bg-destructive text-white hover:bg-destructive/90 hover:text-white dark:border-destructive dark:bg-destructive dark:hover:bg-destructive/90')}
        onClick={() => api.partySetCorrect(answer.playerId, position, false)}><XIcon /></Button>
    </div>
  );
}

function SkipProgress({ skips }) {
  const segmentCount = Math.min(skips.of, 12);
  const filled = Math.round((skips.count / Math.max(skips.of, 1)) * segmentCount);
  return (
    <span className="flex items-center gap-2.5 rounded-full border px-3 py-1.5 text-sm animate-in fade-in-0"
      title="Moves on when every online player taps Skip on the phone">
      <SkipForwardIcon className="size-4 text-emerald-600 dark:text-emerald-400" />
      <span><span className="font-semibold tabular-nums">{skips.count}/{skips.of}</span> <span className="text-muted-foreground">want to skip</span></span>
      <span className="flex gap-0.5">
        {Array.from({ length: segmentCount }, (_, i) => (
          <span key={i} className={cn('h-1.5 w-3 rounded-full bg-muted transition-colors', i < filled && 'bg-emerald-500')} />
        ))}
      </span>
    </span>
  );
}

function LiveAnswers({ party, onKick }) {
  const answersByPlayer = new Map(party.answers.map(answer => [answer.playerId, answer]));
  const showsAnswers = party.phase !== 'waiting';
  return (
    <div className="space-y-2">
      <h2 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        {showsAnswers ? 'Answers' : 'Players'}
        {showsAnswers && <span className="tabular-nums">{answersByPlayer.size} of {party.players.length}</span>}
      </h2>
      <ul className="divide-y rounded-lg border">
        {party.players.map(player => {
          const answer = showsAnswers ? answersByPlayer.get(player.id) : null;
          return (
            <li key={player.id} className="flex items-center gap-2 px-3 py-2">
              <OnlineDot isOnline={player.isOnline} />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 text-sm font-medium"><span className="truncate">{player.name}</span><AwayWarning timesAway={player.timesAway} /></p>
                {showsAnswers && (
                  <p className={cn('truncate text-sm', !answer?.given && 'text-muted-foreground')} title={answer?.given}>
                    {answer ? answer.given || 'Blank' : 'No answer yet'}
                    {answer?.hostCall !== undefined && !answer.isDirectCall && <span className="ml-1.5 text-xs text-muted-foreground">· same as your call</span>}
                  </p>
                )}
              </div>
              {answer?.given && <CallButtons answer={{ ...answer, name: player.name }} position={party.index} />}
              <KickButton player={player} onKick={onKick} />
            </li>
          );
        })}
        {!party.players.length && <li className="px-3 py-2 text-sm text-muted-foreground">No players.</li>}
      </ul>
      {showsAnswers && party.phase === 'question' && (
        <p className="text-xs text-muted-foreground">
          Mark answers now to decide them before time is up. The same answer from another player follows your call; a player who
          changes the answer loses the mark.
        </p>
      )}
    </div>
  );
}

function PlayerAnswers({ party, answers = party.answers, position = party.index }) {
  const answeredIds = new Set(answers.map(answer => answer.playerId));
  const timesAway = new Map(position === party.index ? party.players.map(player => [player.id, player.timesAway]) : []);
  const silentPlayers = party.players.filter(player => !answeredIds.has(player.id));
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-medium text-muted-foreground">Answers</h2>
      <ul className="divide-y rounded-lg border">
        {answers.map(answer => {
          const { label, Icon, className } = OUTCOMES[outcomeOf(answer)];
          return (
            <li key={answer.playerId} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
              <span className="flex w-32 items-center gap-1.5 font-medium"><span className="truncate">{answer.name}</span><AwayWarning timesAway={timesAway.get(answer.playerId)} /></span>
              <span className="min-w-0 flex-1 truncate">{answer.given || '—'}</span>
              <span className={cn('flex items-center gap-1 text-sm font-semibold', className)}><Icon className="size-4" />{label}</span>
              <span className="w-8 text-right text-sm tabular-nums">{pointsLabel(answer.points)}</span>
              <CallButtons answer={answer} position={position} isCalledNow={answer.isCorrect ? true : outcomeOf(answer) === 'wrong' ? false : null} />
            </li>
          );
        })}
        {!answers.length && <li className="px-4 py-3 text-sm text-muted-foreground">Nobody answered.</li>}
      </ul>
      {silentPlayers.length > 0 && answers.length > 0 && (
        <p className="text-sm text-muted-foreground">No answer: {silentPlayers.map(player => player.name).join(', ')}</p>
      )}
    </div>
  );
}

function QuestionForHost({ party, onKick }) {
  const isUpNext = party.phase === 'waiting';
  return (
    <div className="mx-auto grid max-w-6xl gap-8 px-8 py-8 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-6">
        {party.previous && (
          <div className="space-y-4 rounded-lg border p-4">
            <p className="text-sm font-medium text-muted-foreground">Check the answers · question {party.previous.index + 1} of {party.total}</p>
            <CorrectAnswer question={party.previous.question} />
            <PlayerAnswers party={party} answers={party.previous.answers} position={party.previous.index} />
          </div>
        )}
        <p className="text-sm font-medium text-muted-foreground">
          {isUpNext ? `Up next · question ${party.index + 1} of ${party.total}` : `On the TV · question ${party.index + 1} of ${party.total}`}
        </p>
        <QuestionOnScreen question={party.question} textClassName="text-xl" imageClassName="max-h-64" />
        <div className="space-y-2 rounded-lg border border-dashed p-4">
          <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground"><EyeOffIcon className="size-3.5" />Answer · only you see this</p>
          <CorrectAnswer question={party.question} />
        </div>
        {isWaitingToReveal(party) && <PlayerAnswers party={party} />}
      </div>
      <LiveAnswers party={party} onKick={onKick} />
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

const MESSAGE_LENGTH = 300;

function MessageDialog({ isOpen, onOpenChange, announcement }) {
  const [text, setText] = useState('');
  const send = async () => {
    if (!text.trim()) return;
    await api.partyAnnounce(text);
    setText('');
    toast.success('Sent to every phone');
    onOpenChange(false);
  };
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Message to all players</DialogTitle>
          <DialogDescription>
            A clue or an announcement shown on every phone. Players cannot reply. It stays until the next question or until you
            clear it.
          </DialogDescription>
        </DialogHeader>
        {announcement && (
          <div className="flex items-start gap-3 rounded-lg border bg-muted/50 p-3">
            <MegaphoneIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p className="min-w-0 flex-1 text-sm break-words"><span className="text-muted-foreground">On the phones now: </span>{announcement.text}</p>
            <Button size="sm" variant="ghost" onClick={() => api.partyAnnounce('')}><XIcon />Clear</Button>
          </div>
        )}
        <div className="space-y-1.5">
          <Textarea autoFocus rows={3} maxLength={MESSAGE_LENGTH} value={text} placeholder="For example: Think about the year, not the city."
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if (e.key !== 'Enter' || e.shiftKey) return;
              e.preventDefault();
              send();
            }} />
          <p className="text-right text-xs text-muted-foreground tabular-nums">{text.length}/{MESSAGE_LENGTH}</p>
        </div>
        <DialogFooter>
          <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
          <Button disabled={!text.trim()} onClick={send}><SendIcon />{announcement ? 'Replace message' : 'Send to all phones'}<Kbd className={KEY_HINT_ON_PRIMARY_BUTTON}>Enter</Kbd></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AnnouncementStrip({ announcement, onOpen }) {
  return (
    <div className="flex shrink-0 items-center gap-3 border-b bg-muted/40 px-6 py-1.5 text-sm animate-in fade-in-0 slide-in-from-top-1">
      <MegaphoneIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="shrink-0 text-muted-foreground">On every phone:</span>
      <span className="min-w-0 flex-1 truncate font-medium" title={announcement.text}>{announcement.text}</span>
      <Button size="xs" variant="ghost" onClick={onOpen}>Change</Button>
      <Button size="xs" variant="ghost" onClick={() => api.partyAnnounce('')}><XIcon />Clear</Button>
    </div>
  );
}

function PlayersInLobby({ players, onKick }) {
  return (
    <div className="space-y-3">
      <h2 className="flex items-center gap-2 font-medium"><UsersIcon className="size-4" />Players <Badge variant="secondary">{players.length}</Badge></h2>
      {players.length ? (
        <ul className="flex flex-wrap gap-2">
          {players.map(player => (
            <li key={player.id} className="flex items-center gap-1 rounded-full border py-1 pr-1 pl-3 text-sm animate-in fade-in-0 zoom-in-95">
              <OnlineDot isOnline={player.isOnline} />
              <span className="ml-1">{player.name}</span>
              <KickButton player={player} onKick={onKick} />
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-muted-foreground">Waiting for players to scan the code…</p>}
    </div>
  );
}

export default function PartyScreen({ party, isVisible, lobbySettings, onBackToLobby, onClose }) {
  const [isConfirmingClose, setIsConfirmingClose] = useState(false);
  const [playerToKick, setPlayerToKick] = useState(null);
  const [isWritingMessage, setIsWritingMessage] = useState(false);
  const kick = player => (party.phase === 'lobby' && party.round === 0 ? api.partyKick(player.id) : setPlayerToKick(player));
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
    else if ((party.phase === 'reveal' || isWaitingToReveal(party)) && ['Enter', 'ArrowRight'].includes(e.key)) api.partyNext();
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
          <Button variant="outline" size="sm" disabled={!party.players.length} onClick={() => setIsWritingMessage(true)}><MegaphoneIcon />Message</Button>
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
      {party.announcement && <AnnouncementStrip announcement={party.announcement} onOpen={() => setIsWritingMessage(true)} />}
      {isInRound && (
        <Progress value={timerPercent} className={cn('h-1 shrink-0 rounded-none', isRunningOut && '[&>[data-slot=progress-indicator]]:bg-amber-500')} />
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {party.phase === 'lobby' && (
          <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
            <div className="grid gap-6 md:grid-cols-[auto_1fr]">
              <JoinCard urls={party.urls} />
              <div className="space-y-6">
                <PlayersInLobby players={party.players} onKick={kick} />
                {party.round > 0 && (
                  <div className="space-y-2">
                    <h2 className="font-medium">Scores after round {party.round}</h2>
                    <Leaderboard entries={party.leaderboard} />
                  </div>
                )}
              </div>
            </div>
            {lobbySettings}
            <AllTimeLeaderboard />
          </div>
        )}
        {['waiting', 'question', 'judging'].includes(party.phase) && <QuestionForHost party={party} onKick={kick} />}
        {party.phase === 'reveal' && (
          <div className="mx-auto grid max-w-6xl gap-8 px-8 py-8 lg:grid-cols-[1fr_20rem]">
            <div className="space-y-6">
              <p className="line-clamp-3 whitespace-pre-line text-muted-foreground">{withLineBreaks(party.question.text)}</p>
              <CorrectAnswer question={party.question} />
              <PlayerAnswers party={party} />
            </div>
            <div className="space-y-2">
              <h2 className="text-sm font-medium text-muted-foreground">Leaderboard</h2>
              <Leaderboard entries={party.leaderboard} players={party.players} onKick={kick} />
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
            <Leaderboard entries={party.leaderboard} players={party.players} onKick={kick} showsRoundScore />
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
          {party.phase === 'reveal' && hasRunningClock && <span className="text-lg text-muted-foreground">until {isLastQuestion ? 'the round results' : party.rules.revealAtEnd ? 'the next answer' : 'the next question'} (autoplay)</span>}
          {party.phase === 'waiting' && (
            <Button size="lg" onClick={() => api.partySkipWait()}><SkipForwardIcon />Skip wait<Kbd className={KEY_HINT_ON_PRIMARY_BUTTON}>Space</Kbd></Button>
          )}
          {hasRunningClock && (
            party.isPaused
              ? <Button size="lg" variant="outline" onClick={() => api.partyResume()}><PlayIcon />Resume{party.phase !== 'waiting' && <Kbd>Space</Kbd>}</Button>
              : <Button size="lg" variant="outline" onClick={() => api.partyPause()}><PauseIcon />Pause{party.phase !== 'waiting' && <Kbd>Space</Kbd>}</Button>
          )}
          {party.skips.isAvailable && party.skips.count > 0 && <SkipProgress skips={party.skips} />}
          {party.phase === 'question' && <>
            <span className="text-lg"><span className="font-semibold tabular-nums">{answeredCount}</span> of {party.players.length} answered</span>
            <Button size="lg" variant="outline" className="ml-auto" onClick={() => api.partyCloseAnswers()}>Close answers now</Button>
          </>}
          {party.phase === 'judging' && !isWaitingToReveal(party) && <span className="flex items-center gap-2 text-lg"><Spinner />Checking answers…</span>}
          {isWaitingToReveal(party) && (
            <Button size="lg" className="ml-auto" onClick={() => api.partyNext()}>
              <EyeIcon />Show the answers<Kbd className={KEY_HINT_ON_PRIMARY_BUTTON}>Enter</Kbd>
            </Button>
          )}
          {party.phase === 'reveal' && (
            <Button size="lg" className="ml-auto" onClick={() => api.partyNext()}>
              {isLastQuestion ? <><TrophyIcon />Round results</> : <>{party.rules.revealAtEnd ? 'Next answer' : 'Next question'}<ArrowRightIcon /></>}
              <Kbd className={KEY_HINT_ON_PRIMARY_BUTTON}>Enter</Kbd>
            </Button>
          )}
        </div>
      )}

      <MessageDialog isOpen={isWritingMessage} onOpenChange={setIsWritingMessage} announcement={party.announcement} />

      <AlertDialog open={playerToKick != null} onOpenChange={isOpen => !isOpen && setPlayerToKick(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {playerToKick?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Their answers and score are removed from this party. They are not banned: they can join again by typing a name.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => api.partyKick(playerToKick.id)}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
