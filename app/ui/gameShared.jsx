import { useEffect, useRef, useState } from 'react';
import { cn } from 'cn';
import { ChevronDownIcon, LibraryIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';

export const WARNING_AT_SECONDS_LEFT = 10;
export const MIN_SECONDS_TO_CHECK_ANSWERS = 15;
export const withoutIpcPrefix = error => error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
export const pointsLabel = points => (points > 0 ? `+${points}` : points < 0 ? `−${-points}` : '0');
const RANDOM_SOURCE = 'random';

export function QuestionSourceSelect({ id, lists, listId, onListIdChange, className = 'w-64' }) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>Questions</Label>
      <Select value={listId == null ? RANDOM_SOURCE : String(listId)} onValueChange={value => onListIdChange(value === RANDOM_SOURCE ? null : Number(value))}>
        <SelectTrigger id={id} className={className}><SelectValue placeholder="A deleted list" /></SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value={RANDOM_SOURCE}>Random questions</SelectItem>
          {lists.length > 0 && <SelectSeparator />}
          {lists.map(list => (
            <SelectItem key={list.id} value={String(list.id)} disabled={!list.count}>
              {list.name}<span className="text-muted-foreground tabular-nums">{list.count}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

const allGameKeys = sources => sources.flatMap(source => source.games.map(game => game.key));
const formatCount = n => n.toLocaleString('en');

export function chosenGames(games, sources) {
  const known = new Set(allGameKeys(sources));
  return games.filter(key => known.has(key));
}

export function gamesProblem(games, sources) {
  if (!allGameKeys(sources).length) return 'No questions yet. Install a data source in Settings or write your own.';
  if (games.length && !chosenGames(games, sources).length) return 'Its data sources are not installed. Pick other questions.';
  return null;
}

export function gamesSummary(games, sources) {
  const chosen = new Set(chosenGames(games, sources));
  if (!games.length || chosen.size === allGameKeys(sources).length) return 'All questions';
  if (!chosen.size) return 'Missing data sources';
  const parts = sources.flatMap(source => {
    const picked = source.games.filter(game => chosen.has(game.key));
    if (!picked.length) return [];
    if (picked.length === source.games.length) return [source.name];
    return picked.length === 1 ? [`${source.name} · ${picked[0].name}`] : [`${source.name} · ${picked.length} games`];
  });
  return parts.length > 2 ? `${parts.length} sources` : parts.join(', ');
}

export function GamePicker({ id, label = 'From', sources, games, onGamesChange, className = 'w-64' }) {
  const everything = allGameKeys(sources);
  const chosen = new Set(games.length ? chosenGames(games, sources) : everything);
  const change = keys => keys.length && onGamesChange(keys.length === everything.length ? [] : keys);
  const toggle = (keys, isOn) => change(isOn ? [...new Set([...chosen, ...keys])] : [...chosen].filter(key => !keys.includes(key)));
  const keepOpen = event => event.preventDefault();
  return (
    <div className="grid gap-2">
      {label && <Label htmlFor={id}>{label}</Label>}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button id={id} variant="outline" className={cn('justify-between font-normal', className)} disabled={!everything.length}>
            <span className="flex min-w-0 items-center gap-2"><LibraryIcon className="text-muted-foreground" /><span className="truncate">{everything.length ? gamesSummary(games, sources) : 'No questions yet'}</span></span>
            <ChevronDownIcon className="text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-96 w-72">
          <DropdownMenuCheckboxItem checked={chosen.size === everything.length} onSelect={keepOpen}
            onCheckedChange={() => onGamesChange([])}>All questions</DropdownMenuCheckboxItem>
          {sources.map(source => {
            const keys = source.games.map(game => game.key);
            const pickedCount = keys.filter(key => chosen.has(key)).length;
            const total = source.games.reduce((sum, game) => sum + game.n, 0);
            return (
              <div key={source.id}>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem checked={pickedCount === keys.length} onSelect={keepOpen} onCheckedChange={isOn => toggle(keys, isOn)}
                  className="font-medium">
                  <span className="flex-1 truncate">{source.name}</span>
                  <span className="text-xs font-normal text-muted-foreground tabular-nums">
                    {pickedCount > 0 && pickedCount < keys.length ? `${pickedCount} of ${keys.length}` : formatCount(total)}
                  </span>
                </DropdownMenuCheckboxItem>
                {source.games.length > 1 && source.games.map(game => (
                  <DropdownMenuCheckboxItem key={game.key} checked={chosen.has(game.key)} onSelect={keepOpen} onCheckedChange={isOn => toggle([game.key], isOn)}
                    className="pl-5">
                    <span className="flex-1 truncate">{game.name}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">{formatCount(game.n)}</span>
                  </DropdownMenuCheckboxItem>
                ))}
              </div>
            );
          })}
          {!sources.length && <DropdownMenuLabel className="font-normal text-muted-foreground">No questions yet</DropdownMenuLabel>}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function NumberField({ id, label, value, min, max, step = 1, onChange, isOptional = false, placeholder, className = 'w-28' }) {
  const shown = value == null ? '' : String(value);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const isAllowed = number => Number.isFinite(number) && number >= min && number <= max;
  return (
    <div className="grid gap-2">
      {label && <Label htmlFor={id}>{label}</Label>}
      <Input id={id} type="number" min={min} max={max} step={step} value={draft} placeholder={placeholder} className={className}
        aria-label={label ? undefined : placeholder}
        onChange={e => {
          setDraft(e.target.value);
          if (isOptional && e.target.value.trim() === '') return onChange(null);
          const number = Math.round(Number(e.target.value));
          if (e.target.value.trim() !== '' && isAllowed(number)) onChange(number);
        }}
        onBlur={() => setDraft(shown)} />
    </div>
  );
}

export function Media({ src, kind, alt, className }) {
  if (kind === 'video') return <video src={src} controls playsInline preload="metadata" className={cn('rounded-lg border bg-black', className)} />;
  if (kind === 'audio') return <audio src={src} controls preload="metadata" className="w-full max-w-md" />;
  return <img src={src} alt={alt} className={cn('rounded-lg border object-contain', className)} />;
}
export const KEY_HINT_ON_PRIMARY_BUTTON = 'bg-primary-foreground/15 text-primary-foreground';

export const formatClock = seconds => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
export const withLineBreaks = text => (text ?? '').replaceAll('/-/', '\n');

function playTone(durationMs, frequencyHz) {
  const audio = (playTone.context ??= new AudioContext());
  const oscillator = audio.createOscillator();
  const volume = audio.createGain();
  oscillator.frequency.value = frequencyHz;
  volume.gain.value = 0.2;
  oscillator.connect(volume).connect(audio.destination);
  oscillator.start();
  oscillator.stop(audio.currentTime + durationMs / 1000);
}
export const playTenSecondsLeftTone = () => playTone(150, 660);
export const playTimeUpTone = () => playTone(700, 440);

export function useCountdown(endsAt, onFinish) {
  const [secondsLeft, setSecondsLeft] = useState(0);
  const latestOnFinish = useRef(onFinish);
  latestOnFinish.current = onFinish;
  useEffect(() => {
    if (!endsAt) return;
    const tick = () => {
      const remaining = (endsAt - Date.now()) / 1000;
      if (remaining > 0) return setSecondsLeft(remaining);
      clearInterval(countdown);
      setSecondsLeft(0);
      latestOnFinish.current();
    };
    const countdown = setInterval(tick, 100);
    tick();
    return () => clearInterval(countdown);
  }, [endsAt]);
  return secondsLeft;
}

export function QuestionOnScreen({ question, textClassName = 'text-3xl', imageClassName = 'max-h-[28rem]' }) {
  const credits = [question.package_name ?? question.tournament_name, (question.authors ?? []).map(a => a.fullname.trim()).join(', ')];
  return (
    <div className="space-y-6">
      {question.note_before && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
          <span className="font-medium">Before the question: </span>{question.note_before}
        </div>
      )}
      <p className={cn('leading-snug font-medium whitespace-pre-line', textClassName)}>{withLineBreaks(question.text)}</p>
      {(question.rekvizit_src || question.rekvizit_text) && (
        <div className="space-y-2">
          <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Handout</div>
          {question.rekvizit_src && <Media src={question.rekvizit_src} kind={question.rekvizit_kind} alt="Handout" className={imageClassName} />}
          {question.rekvizit_text && <p className="whitespace-pre-line">{question.rekvizit_text}</p>}
        </div>
      )}
      <p className="text-sm text-muted-foreground">{credits.filter(Boolean).join(' · ')}</p>
    </div>
  );
}

export function NextQuestionNumber({ number, total }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-3 px-8 py-10 text-center animate-in fade-in-0">
      <p className="text-lg font-medium text-muted-foreground">Question</p>
      <p className="text-[12rem] leading-none font-semibold tabular-nums">{number}</p>
      <p className="text-lg text-muted-foreground">of {total}</p>
    </div>
  );
}
