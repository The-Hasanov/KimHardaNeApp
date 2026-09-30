import { useEffect, useState } from 'react';
import { cn } from 'cn';
import { AwardIcon, CopyIcon, DicesIcon, FlameIcon, LayoutTemplateIcon, PencilIcon, PlusIcon, SigmaIcon, Trash2Icon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { toast } from 'sonner';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { NumberField, pointsLabel, withoutIpcPrefix } from './gameShared';

const { api } = window;
const MAX_POOL_VALUES = 8;
const POINTS = { min: -1000, max: 1000 };

export function roundProblemOf(system, questionCount) {
  if (!system || system.mode !== 'pool' || system.pool.some(entry => entry.uses == null)) return null;
  const picks = system.pool.reduce((sum, entry) => sum + entry.uses, 0);
  return questionCount > picks ? `This round has ${questionCount} questions, but “${system.name}” allows only ${picks} picks.` : null;
}

export function usePointSystems() {
  const [pointSystems, setPointSystems] = useState(null);
  useEffect(() => {
    api.pointSystems().then(setPointSystems);
  }, []);
  return [pointSystems, setPointSystems];
}

export function PointSystemSummary({ system, className }) {
  return (
    <ul className={cn('space-y-0.5 text-sm text-muted-foreground', className)}>
      {system.summary?.map(line => <li key={line}>{line}</li>)}
    </ul>
  );
}

export function PointSystemSelect({ id = 'point-system', pointSystems, value, onChange, questionCount, onManage }) {
  const chosen = pointSystems?.find(system => system.id === value) ?? pointSystems?.[0];
  const problem = roundProblemOf(chosen, questionCount);
  return (
    <div className="grid basis-full gap-2">
      <Label htmlFor={id}>Point system</Label>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <Select value={chosen ? String(chosen.id) : ''} onValueChange={next => onChange(Number(next))} disabled={!pointSystems}>
          <SelectTrigger id={id} className="w-56"><SelectValue placeholder="Loading…" /></SelectTrigger>
          <SelectContent position="popper">
            {pointSystems?.map(system => <SelectItem key={system.id} value={String(system.id)}>{system.name}</SelectItem>)}
          </SelectContent>
        </Select>
        {chosen && <PointSystemSummary system={chosen} className="min-w-0 flex-1 pt-1.5" />}
        {onManage && <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={onManage}><PencilIcon />Edit point systems</Button>}
      </div>
      {problem && (
        <p className="flex items-center gap-2 text-sm text-destructive"><TriangleAlertIcon className="size-4 shrink-0" />{problem} Add uses to the pool or play fewer questions.</p>
      )}
    </div>
  );
}

function ExtraCard({ id, Icon, title, description, isOn, onToggle, isDisabled = false, disabledReason, children }) {
  return (
    <div className={cn('rounded-lg border', isOn && !isDisabled && 'border-primary/30 bg-muted/30')}>
      <div className="flex items-start gap-3 p-4">
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 space-y-0.5">
          <Label htmlFor={id} className="font-medium">{title}</Label>
          <p className="text-sm text-muted-foreground">{isDisabled ? disabledReason : description}</p>
        </div>
        <Switch id={id} checked={isOn && !isDisabled} disabled={isDisabled} onCheckedChange={onToggle} />
      </div>
      {isOn && !isDisabled && <div className="flex flex-wrap items-end gap-x-6 gap-y-4 border-t px-4 py-4">{children}</div>}
    </div>
  );
}

const Example = ({ children }) => <p className="basis-full text-sm text-muted-foreground">{children}</p>;

function streakExample(draft) {
  const base = draft.mode === 'pool' ? null : draft.simple.correct;
  const { from, bonus, isGrowing } = draft.streak;
  const length = from + 2;
  const bonuses = Array.from({ length }, (_, i) => (i + 1 >= from ? bonus * (isGrowing ? i + 2 - from : 1) : 0));
  if (base == null) return `Correct answers ${from} to ${length} in a row add ${bonuses.slice(from - 1).map(pointsLabel).join(', ')} on top of the picked points. A wrong or missing answer starts the count again.`;
  const points = bonuses.map(extra => base + extra);
  return `${length} correct in a row: ${points.join(', ')} = ${points.reduce((sum, value) => sum + value, 0)}. A wrong or missing answer starts the count again.`;
}

function allOrNothingExample(draft) {
  const all = draft.mode === 'pool' ? 'the picked points' : `5 × ${draft.simple.correct} = ${5 * draft.simple.correct}`;
  return `5 questions, all correct: ${all}. One wrong answer${draft.allOrNothing.unansweredCountsAsWrong ? ' or no answer' : ''}: 0 for the round.`;
}

function perfectBonusExample(draft) {
  const bonus = pointsLabel(draft.perfectBonus.points);
  if (draft.mode === 'pool') return `A round with every answer right gets the picked points ${bonus}.`;
  const earned = 5 * draft.simple.correct;
  return `5 questions, all correct: ${earned} ${bonus} = ${earned + draft.perfectBonus.points}. One wrong${draft.allOrNothing.isOn && !draft.allOrNothing.unansweredCountsAsWrong ? '' : ' or missing'} answer and there is no bonus.`;
}

function PoolEditor({ pool, onChange }) {
  const update = (index, changes) => onChange(pool.map((entry, i) => (i === index ? { ...entry, ...changes } : entry)));
  const add = () => {
    const top = Math.max(0, ...pool.map(entry => entry.points));
    onChange([...pool, { points: top + 10, wrong: 0, unanswered: 0, uses: null }]);
  };
  const duplicates = new Set(pool.map(entry => entry.points).filter((points, i, all) => all.indexOf(points) !== i));
  return (
    <div className="basis-full space-y-2">
      <div className="grid grid-cols-[repeat(4,6rem)_2rem] gap-x-3 text-sm font-medium">
        <span>Points</span><span>Wrong</span><span>No answer</span><span>Uses</span>
      </div>
      {pool.map((entry, index) => (
        <div key={index} className="grid grid-cols-[repeat(4,6rem)_2rem] items-center gap-x-3">
          <NumberField id={`pool-points-${index}`} placeholder="Points" value={entry.points} min={1} max={POINTS.max} className={cn('w-24', duplicates.has(entry.points) && 'border-destructive')}
            onChange={points => update(index, { points })} />
          <NumberField id={`pool-wrong-${index}`} placeholder="Wrong" value={entry.wrong} min={POINTS.min} max={POINTS.max} className="w-24" onChange={wrong => update(index, { wrong })} />
          <NumberField id={`pool-unanswered-${index}`} placeholder="No answer" value={entry.unanswered} min={POINTS.min} max={POINTS.max} className="w-24"
            onChange={unanswered => update(index, { unanswered })} />
          <NumberField id={`pool-uses-${index}`} placeholder="Any" value={entry.uses} min={1} max={99} className="w-24" isOptional onChange={uses => update(index, { uses })} />
          <Button size="icon-sm" variant="ghost" className="text-muted-foreground" aria-label={`Remove ${entry.points}`} disabled={pool.length <= 1}
            onClick={() => onChange(pool.filter((_entry, i) => i !== index))}><XIcon /></Button>
        </div>
      ))}
      {duplicates.size > 0 && <p className="text-sm text-destructive">Each value can be in the pool once.</p>}
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <Button size="sm" variant="outline" onClick={add} disabled={pool.length >= MAX_POOL_VALUES}><PlusIcon />Add value</Button>
        <span className="text-sm text-muted-foreground">Players pick a value for each question. Leave Uses empty for no limit per round.</span>
      </div>
    </div>
  );
}

function PointSystemEditor({ system, onOpenChange, onSaved }) {
  const [draft, setDraft] = useState(system);
  const [error, setError] = useState('');
  useEffect(() => {
    setDraft(system);
    setError('');
  }, [system]);
  if (!draft) return null;
  const set = (key, changes) => setDraft(current => ({ ...current, [key]: typeof changes === 'object' && !Array.isArray(changes) ? { ...current[key], ...changes } : changes }));
  const hasDuplicates = new Set(draft.pool.map(entry => entry.points)).size !== draft.pool.length;
  const save = async () => {
    try {
      const { id, pointSystems } = await api.savePointSystem(draft);
      onSaved(pointSystems, id);
      toast.success(`${draft.name.trim()} is saved`);
    } catch (e) {
      setError(withoutIpcPrefix(e));
    }
  };
  return (
    <Dialog open={system != null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{draft.id ? `Edit ${system?.name ?? draft.name}` : 'New point system'}</DialogTitle>
          <DialogDescription>Choose it for any party round. Templates that use it follow your changes.</DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          <div className="grid gap-2">
            <Label htmlFor="point-system-name">Name</Label>
            <Input id="point-system-name" autoFocus maxLength={40} value={draft.name} placeholder="For example: Brave pool"
              onChange={e => { setDraft({ ...draft, name: e.target.value }); setError(''); }} />
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <div className="space-y-3 rounded-lg border p-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-medium">Points</span>
              <Tabs value={draft.mode} onValueChange={mode => set('mode', mode)} className="ml-auto">
                <TabsList>
                  <TabsTrigger value="simple" className="px-3">Fixed points</TabsTrigger>
                  <TabsTrigger value="pool" className="px-3">Point pool</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
            {draft.mode === 'simple' ? (
              <div className="flex flex-wrap gap-x-6 gap-y-4">
                <NumberField id="simple-correct" label="Correct" value={draft.simple.correct} {...POINTS} onChange={correct => set('simple', { correct })} />
                <NumberField id="simple-wrong" label="Wrong" value={draft.simple.wrong} {...POINTS} onChange={wrong => set('simple', { wrong })} />
                <NumberField id="simple-unanswered" label="No answer" value={draft.simple.unanswered} {...POINTS} onChange={unanswered => set('simple', { unanswered })} />
                <Example>Use a negative number as a penalty.</Example>
              </div>
            ) : <PoolEditor pool={draft.pool} onChange={pool => set('pool', pool)} />}
          </div>
          <ExtraCard id="streak" Icon={FlameIcon} title="Streak bonus" description="Extra points for correct answers in a row."
            isOn={draft.streak.isOn} onToggle={isOn => set('streak', { isOn })}>
            <NumberField id="streak-from" label="From correct in a row" value={draft.streak.from} min={2} max={20} onChange={from => set('streak', { from })} />
            <NumberField id="streak-bonus" label="Bonus" value={draft.streak.bonus} min={1} max={POINTS.max} onChange={bonus => set('streak', { bonus })} />
            <RadioGroup value={draft.streak.isGrowing ? 'growing' : 'flat'} onValueChange={value => set('streak', { isGrowing: value === 'growing' })} className="flex h-8 gap-x-5">
              <div className="flex items-center gap-2"><RadioGroupItem id="streak-flat" value="flat" /><Label htmlFor="streak-flat" className="font-normal">Same bonus</Label></div>
              <div className="flex items-center gap-2"><RadioGroupItem id="streak-growing" value="growing" /><Label htmlFor="streak-growing" className="font-normal">Growing bonus</Label></div>
            </RadioGroup>
            <Example>{streakExample(draft)}</Example>
          </ExtraCard>
          <ExtraCard id="all-or-nothing" Icon={SigmaIcon} title="All or nothing" description="Players score only when they answer every question in the round correctly."
            isOn={draft.allOrNothing.isOn} onToggle={isOn => set('allOrNothing', { isOn })}>
            <div className="flex h-8 items-center gap-2">
              <Switch id="unanswered-counts" checked={draft.allOrNothing.unansweredCountsAsWrong}
                onCheckedChange={unansweredCountsAsWrong => set('allOrNothing', { unansweredCountsAsWrong })} />
              <Label htmlFor="unanswered-counts" className="font-normal">No answer counts as wrong</Label>
            </div>
            <Example>{allOrNothingExample(draft)}</Example>
          </ExtraCard>
          <ExtraCard id="perfect-bonus" Icon={AwardIcon} title="All correct bonus" description="Extra points at the end of a round for players who got every answer right."
            isOn={draft.perfectBonus.isOn} onToggle={isOn => set('perfectBonus', { isOn })}>
            <NumberField id="perfect-bonus-points" label="Bonus" value={draft.perfectBonus.points} min={1} max={POINTS.max}
              onChange={points => set('perfectBonus', { points })} />
            <Example>{perfectBonusExample(draft)}</Example>
          </ExtraCard>
          <ExtraCard id="risk" Icon={DicesIcon} title="Risk" description="Players can risk an answer: more points when right, a bigger loss when wrong."
            isOn={draft.risk.isOn} onToggle={isOn => set('risk', { isOn })} isDisabled={draft.mode === 'pool'}
            disabledReason="Not with a point pool: picking a high value already is a risk.">
            <NumberField id="risk-correct" label="Risked correct" value={draft.risk.correct} {...POINTS} onChange={correct => set('risk', { correct })} />
            <NumberField id="risk-wrong" label="Risked wrong" value={draft.risk.wrong} {...POINTS} onChange={wrong => set('risk', { wrong })} />
            <NumberField id="risk-limit" label="Risks per round" value={draft.risk.limit} min={1} max={99} placeholder="Any" isOptional onChange={limit => set('risk', { limit })} />
            <Example>
              Correct {pointsLabel(draft.simple.correct)}, risked correct {pointsLabel(draft.risk.correct)} · wrong {pointsLabel(draft.simple.wrong)}, risked wrong {pointsLabel(draft.risk.wrong)} ·
              no answer {pointsLabel(draft.simple.unanswered)}. {draft.risk.limit ? `Each player can risk ${draft.risk.limit} ${draft.risk.limit === 1 ? 'time' : 'times'} per round.` : 'No limit per round.'}
            </Example>
          </ExtraCard>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={!draft.name.trim() || hasDuplicates}>Save point system</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function PointSystems() {
  const [pointSystems, setPointSystems] = usePointSystems();
  const [editing, setEditing] = useState(null);
  const [systemToDelete, setSystemToDelete] = useState(null);
  const remove = async system => {
    try {
      setPointSystems(await api.deletePointSystem(system.id));
      toast.success(`${system.name} is deleted`);
    } catch (e) {
      toast.error(`Could not delete ${system.name}`, { description: withoutIpcPrefix(e) });
    }
  };
  const editable = ({ summary, updated_at, usedBy, ...system }) => system;
  if (!pointSystems) return null;
  return (
    <div className="mx-auto max-w-3xl space-y-5 px-6 py-8">
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          <h1 className="text-2xl font-semibold">Point systems</h1>
          <p className="text-muted-foreground">Save the ways you like to score, then pick one for each party round.</p>
        </div>
        <Button onClick={async () => setEditing(await api.newPointSystem())}><PlusIcon />New point system</Button>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2">
        {pointSystems.map(system => (
          <li key={system.id} className="flex flex-col gap-3 rounded-lg border p-4">
            <div className="flex items-start gap-2">
              <h2 className="min-w-0 flex-1 truncate font-medium">{system.name}</h2>
              <Button size="icon-sm" variant="ghost" className="text-muted-foreground" aria-label={`Edit ${system.name}`} title="Edit" onClick={() => setEditing(editable(system))}><PencilIcon /></Button>
              <Button size="icon-sm" variant="ghost" className="text-muted-foreground" aria-label={`Duplicate ${system.name}`} title="Duplicate"
                onClick={() => setEditing({ ...editable(system), id: undefined, name: `${system.name} copy`.slice(0, 40) })}><CopyIcon /></Button>
              <Button size="icon-sm" variant="ghost" className="text-muted-foreground" aria-label={`Delete ${system.name}`}
                title={system.usedBy?.length ? 'Used by a template, so it cannot be deleted' : 'Delete'}
                disabled={pointSystems.length <= 1 || system.usedBy?.length > 0} onClick={() => setSystemToDelete(system)}><Trash2Icon /></Button>
            </div>
            <PointSystemSummary system={system} />
            {system.usedBy?.length > 0 && (
              <p className="mt-auto flex items-center gap-1.5 text-xs text-muted-foreground">
                <LayoutTemplateIcon className="size-3.5" />Used by {system.usedBy.join(', ')}
              </p>
            )}
          </li>
        ))}
      </ul>
      <PointSystemEditor system={editing} onOpenChange={isOpen => !isOpen && setEditing(null)}
        onSaved={systems => { setPointSystems(systems); setEditing(null); }} />
      <AlertDialog open={systemToDelete != null} onOpenChange={isOpen => !isOpen && setSystemToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {systemToDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>Rounds already played keep their scores.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => remove(systemToDelete)}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
