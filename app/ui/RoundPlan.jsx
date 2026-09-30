import { useEffect, useState } from 'react';
import { cn } from 'cn';
import { CheckIcon, ChevronDownIcon, CopyIcon, LayoutTemplateIcon, PlusIcon, SaveIcon, Trash2Icon, TriangleAlertIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { GamePicker, MIN_SECONDS_TO_CHECK_ANSWERS, NumberField, QuestionSourceSelect, gamesProblem, gamesSummary, withoutIpcPrefix } from './gameShared';
import { PointSystemSelect, roundProblemOf } from './PointSystems';

const { api } = window;
const MAX_ROUNDS = 20;
const DEFAULT_SECONDS_ON_ANSWER = 10;
export const NEW_ROUND = {
  listId: null, randomCount: 10, games: [], secondsPerQuestion: 60, secondsBetweenQuestions: 0, revealAtEnd: false, secondsOnAnswer: 0, pointSystemId: null,
};

export const pointSystemOf = (round, pointSystems) => pointSystems?.find(system => system.id === round.pointSystemId) ?? pointSystems?.[0] ?? null;
const listOf = (round, lists) => (round.listId == null ? null : lists.find(list => list.id === round.listId));

export function questionCountOf(round, lists) {
  return round.listId == null ? round.randomCount : listOf(round, lists)?.count ?? 0;
}

export function roundProblem(round, lists, pointSystems, sources) {
  if (round.listId != null && !listOf(round, lists)) return 'Its list was deleted. Choose other questions.';
  if (round.listId == null && gamesProblem(round.games ?? [], sources)) return gamesProblem(round.games ?? [], sources);
  if (!questionCountOf(round, lists)) return 'Its list has no questions.';
  return roundProblemOf(pointSystemOf(round, pointSystems), questionCountOf(round, lists));
}

export function roundSummary(round, lists, pointSystems, sources) {
  const list = listOf(round, lists);
  const from = gamesSummary(round.games ?? [], sources);
  const questions = round.listId != null ? (list ? `${list.name} (${list.count})` : 'a deleted list')
    : `${round.randomCount} random questions${from === 'All questions' ? '' : ` from ${from}`}`;
  return [
    questions,
    `${round.secondsPerQuestion} s each`,
    round.revealAtEnd && 'answers at the end',
    round.secondsOnAnswer > 0 && 'autoplay',
    pointSystemOf(round, pointSystems)?.name,
  ].filter(Boolean).join(' · ');
}

function RoundEditor({ index, round, lists, pointSystems, sources, onChange }) {
  const id = name => `round-${index}-${name}`;
  const set = changes => onChange({ ...round, ...changes });
  return (
    <div className="flex flex-wrap items-end gap-x-6 gap-y-4 border-t px-4 py-4">
      <QuestionSourceSelect id={id('questions')} lists={lists} listId={round.listId} onListIdChange={listId => set({ listId })} className="w-56" />
      {round.listId == null && <>
        <GamePicker id={id('games')} sources={sources} games={round.games ?? []} onGamesChange={games => set({ games })} className="w-56" />
        <NumberField id={id('count')} label="How many" value={round.randomCount} min={1} max={50} onChange={randomCount => set({ randomCount })} />
      </>}
      <div className="grid basis-full gap-2">
        <Label>Show the answers</Label>
        <RadioGroup value={round.revealAtEnd ? 'end' : 'each'} className="flex flex-wrap gap-x-6 gap-y-2"
          onValueChange={value => set({ revealAtEnd: value === 'end', ...(value === 'end' && { secondsBetweenQuestions: Math.max(round.secondsBetweenQuestions, MIN_SECONDS_TO_CHECK_ANSWERS) }) })}>
          <div className="flex items-center gap-2">
            <RadioGroupItem id={id('each')} value="each" />
            <Label htmlFor={id('each')} className="font-normal">After each question</Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem id={id('end')} value="end" />
            <Label htmlFor={id('end')} className="font-normal">At the end of the round</Label>
          </div>
        </RadioGroup>
      </div>
      <NumberField id={id('seconds')} label="Seconds per question" value={round.secondsPerQuestion} min={10} max={600} step={5}
        onChange={secondsPerQuestion => set({ secondsPerQuestion })} />
      <NumberField id={id('between')} label="Seconds between questions" value={round.secondsBetweenQuestions} step={5}
        min={round.revealAtEnd ? MIN_SECONDS_TO_CHECK_ANSWERS : 0} max={120} onChange={secondsBetweenQuestions => set({ secondsBetweenQuestions })} />
      <div className="flex h-8 items-center gap-2">
        <Switch id={id('autoplay')} checked={round.secondsOnAnswer > 0} onCheckedChange={isOn => set({ secondsOnAnswer: isOn ? DEFAULT_SECONDS_ON_ANSWER : 0 })} />
        <Label htmlFor={id('autoplay')} className="font-normal">Autoplay</Label>
      </div>
      {round.secondsOnAnswer > 0 && (
        <NumberField id={id('on-answer')} label="Seconds on the answer" value={round.secondsOnAnswer} min={3} max={120} step={5}
          onChange={secondsOnAnswer => set({ secondsOnAnswer })} />
      )}
      <PointSystemSelect id={id('points')} pointSystems={pointSystems} value={pointSystemOf(round, pointSystems)?.id}
        questionCount={questionCountOf(round, lists)} onChange={pointSystemId => set({ pointSystemId })} />
    </div>
  );
}

function SaveTemplateDialog({ isOpen, onOpenChange, rounds, templates, suggestedName, onSaved }) {
  const [name, setName] = useState(suggestedName);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!isOpen) return;
    setName(suggestedName);
    setError('');
  }, [isOpen]);
  const existing = templates?.find(template => template.name.toLowerCase() === name.trim().toLowerCase());
  const save = async () => {
    try {
      const { templates: saved } = await api.saveGameTemplate({ id: existing?.id, name, rounds });
      onSaved(saved, name.trim());
      onOpenChange(false);
      toast.success(`${name.trim()} is saved`, { description: `${rounds.length} ${rounds.length === 1 ? 'round' : 'rounds'}. Find it under Templates.` });
    } catch (e) {
      setError(withoutIpcPrefix(e));
    }
  };
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save as template</DialogTitle>
          <DialogDescription>Keeps these {rounds.length} {rounds.length === 1 ? 'round' : 'rounds'} with their questions, timers and point systems.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="template-name">Name</Label>
          <Input id="template-name" autoFocus maxLength={60} value={name} placeholder="For example: Friday night"
            onChange={e => { setName(e.target.value); setError(''); }}
            onKeyDown={e => e.key === 'Enter' && name.trim() && save()} />
          {existing && !error && <p className="text-sm text-amber-700 dark:text-amber-400">This replaces the template “{existing.name}”.</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={!name.trim()}><SaveIcon />{existing ? 'Replace template' : 'Save template'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function RoundPlan({ rounds, onRoundsChange, lists, pointSystems, sources, templates, onTemplatesChange, templateName, onTemplateNameChange, playedCount = 0, action }) {
  const [openIndex, setOpenIndex] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const blockedCount = rounds.filter((round, index) => index >= playedCount && roundProblem(round, lists, pointSystems, sources)).length;
  const change = (index, round) => onRoundsChange(rounds.map((current, i) => (i === index ? round : current)));
  const add = () => {
    onRoundsChange([...rounds, { ...(rounds.at(-1) ?? NEW_ROUND) }]);
    setOpenIndex(rounds.length);
  };
  const duplicate = index => {
    onRoundsChange([...rounds.slice(0, index + 1), { ...rounds[index] }, ...rounds.slice(index + 1)]);
    setOpenIndex(index + 1);
  };
  const remove = index => {
    onRoundsChange(rounds.filter((_round, i) => i !== index));
    setOpenIndex(null);
  };
  const applyTemplate = id => {
    const template = templates.find(candidate => candidate.id === Number(id));
    if (!template) return;
    onRoundsChange([...rounds.slice(0, playedCount), ...template.rounds]);
    onTemplateNameChange(template.name);
    setOpenIndex(null);
    toast.success(`Using ${template.name}`, { description: playedCount ? `Its rounds come after the ${playedCount} played.` : `${template.rounds.length} ${template.rounds.length === 1 ? 'round' : 'rounds'}.` });
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 font-medium">Rounds <Badge variant="secondary">{rounds.length}</Badge></h2>
        {templateName && <span className="text-sm text-muted-foreground">from “{templateName}”</span>}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select value="" onValueChange={applyTemplate} disabled={!templates?.length}>
            <SelectTrigger size="sm" className="w-44" aria-label="Use a template">
              <LayoutTemplateIcon /><SelectValue placeholder={templates?.length ? 'Use a template' : 'No templates yet'} />
            </SelectTrigger>
            <SelectContent position="popper" align="end">
              {templates?.map(template => (
                <SelectItem key={template.id} value={String(template.id)}>
                  {template.name}<span className="text-muted-foreground tabular-nums">{template.rounds.length}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" onClick={() => setIsSaving(true)} disabled={!rounds.length}><SaveIcon />Save as template</Button>
          {action}
        </div>
      </div>
      <ol className="space-y-2">
        {rounds.map((round, index) => {
          const isPlayed = index < playedCount;
          const isNext = index === playedCount;
          const isOpen = openIndex === index && !isPlayed;
          const problem = !isPlayed && roundProblem(round, lists, pointSystems, sources);
          return (
            <li key={index} className={cn('rounded-lg border', isNext && 'border-primary/40', isPlayed && 'bg-muted/40')}>
              <div className="flex items-center gap-3 px-4 py-2.5">
                <span className={cn('grid size-7 shrink-0 place-items-center rounded-full border text-sm font-semibold tabular-nums',
                  isNext && 'border-primary bg-primary text-primary-foreground', isPlayed && 'text-muted-foreground')}>
                  {isPlayed ? <CheckIcon className="size-4" /> : index + 1}
                </span>
                <button type="button" className="min-w-0 flex-1 text-left disabled:cursor-default" disabled={isPlayed}
                  onClick={() => setOpenIndex(isOpen ? null : index)} aria-expanded={isOpen}>
                  <span className="flex items-center gap-2 text-sm font-medium">
                    Round {index + 1}
                    {isPlayed && <span className="font-normal text-muted-foreground">played</span>}
                    {isNext && playedCount > 0 && <Badge variant="secondary">Next</Badge>}
                    {problem && <TriangleAlertIcon className="size-4 text-destructive" aria-label="Cannot start" />}
                  </span>
                  <span className={cn('block truncate text-sm text-muted-foreground', problem && !isOpen && 'text-destructive')}>
                    {problem && !isOpen ? problem : roundSummary(round, lists, pointSystems, sources)}
                  </span>
                </button>
                {!isPlayed && <>
                  <Button size="icon-sm" variant="ghost" className="text-muted-foreground" aria-label={`Duplicate round ${index + 1}`} title="Duplicate"
                    disabled={rounds.length >= MAX_ROUNDS} onClick={() => duplicate(index)}><CopyIcon /></Button>
                  <Button size="icon-sm" variant="ghost" className="text-muted-foreground" aria-label={`Remove round ${index + 1}`} title="Remove"
                    disabled={rounds.length <= 1} onClick={() => remove(index)}><Trash2Icon /></Button>
                  <Button size="icon-sm" variant="ghost" aria-label={isOpen ? 'Close' : `Edit round ${index + 1}`} onClick={() => setOpenIndex(isOpen ? null : index)}>
                    <ChevronDownIcon className={cn('transition-transform', isOpen && 'rotate-180')} />
                  </Button>
                </>}
              </div>
              {isOpen && <RoundEditor index={index} round={round} lists={lists} pointSystems={pointSystems} sources={sources} onChange={next => change(index, next)} />}
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" onClick={add} disabled={rounds.length >= MAX_ROUNDS}><PlusIcon />Add round</Button>
        <span className={cn('text-sm text-muted-foreground', blockedCount > 0 && 'text-destructive')}>
          {blockedCount > 0 ? `Fix the ${blockedCount === 1 ? 'round' : 'rounds'} marked in red: the game cannot start until every planned round fits its point system.`
            : playedCount >= rounds.length && playedCount > 0 ? 'Every planned round is played. Add a round to keep playing.' : 'Open a round to change it. Rounds not played yet can change during the game.'}
        </span>
      </div>
      <SaveTemplateDialog isOpen={isSaving} onOpenChange={setIsSaving} rounds={rounds} templates={templates} suggestedName={templateName ?? ''}
        onSaved={(saved, name) => { onTemplatesChange(saved); onTemplateNameChange(name); }} />
    </div>
  );
}
