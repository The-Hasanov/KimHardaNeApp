import { useState } from 'react';
import { CircleAlertIcon, CircleCheckIcon, DatabaseIcon, LayersIcon, MoonIcon, RefreshCwIcon, RotateCcwIcon, SparklesIcon, SquareIcon, ZapIcon } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { setNightMode, useNightMode } from './theme';

const REFRESH_MODES = [
  ['quick', ZapIcon, 'Quick', 'about 2 min', 'Download packages published since the last refresh.'],
  ['full', LayersIcon, 'Full', 'about 20 min', 'Re-check every package for changes made on 3sual.az.'],
];
const formatCount = n => n.toLocaleString('en');
const megabytes = bytes => formatCount(Math.round(bytes / 1e6));
const timeLeft = seconds => (seconds == null ? '' : seconds < 90 ? ' · about a minute left' : ` · about ${Math.round(seconds / 60)} min left`);

export function describeAiWork(status) {
  switch (status.state) {
    case 'downloading':
      if (status.total && status.loaded >= status.total) return { text: 'Preparing the AI model…' };
      return {
        text: status.total ? `Downloading the AI model ${megabytes(status.loaded)} / ${megabytes(status.total)} MB` : 'Downloading the AI model…',
        percent: status.total ? (status.loaded / status.total) * 100 : 0,
      };
    case 'loading':
      return { text: 'Loading the AI model…' };
    case 'indexing':
      return {
        text: `Building the AI index ${formatCount(status.done)} / ${formatCount(status.total)}${timeLeft(status.secondsLeft)}`,
        percent: (status.done / status.total) * 100,
      };
    case 'stopping':
      return { text: 'Removing the AI model and index…' };
    default:
      return null;
  }
}

function RefreshSection({ refresh }) {
  return (
    <section className="grid gap-3 rounded-lg border p-4">
      <div className="grid gap-1">
        <Label className="text-base"><DatabaseIcon className="size-4" />Refresh data</Label>
        <p className="text-muted-foreground">
          Download new or changed questions from 3sual.az, one request per second. Keep searching and editing while it
          runs; your edits are never overwritten.
        </p>
        {refresh.dataDate && <p className="text-xs text-muted-foreground">Last checked {refresh.dataDate.slice(0, 10)}</p>}
      </div>
      {refresh.isRunning ? (
        <div className="grid gap-2">
          <span className="flex items-center gap-2"><Spinner />{refresh.stage}</span>
          {refresh.percent != null && <Progress value={refresh.percent} />}
          <Button variant="outline" className="justify-self-start" onClick={refresh.onStop} disabled={refresh.isStopping}>
            <SquareIcon className="fill-current" />Stop refresh
          </Button>
        </div>
      ) : (
        <>
          <RadioGroup value={refresh.mode} onValueChange={refresh.onModeChange} className="grid-cols-2">
            {REFRESH_MODES.map(([value, Icon, title, time, description]) => (
              <Label key={value} htmlFor={`refresh-${value}`}
                className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal transition-colors hover:bg-muted/50 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-muted/50">
                <RadioGroupItem id={`refresh-${value}`} value={value} className="mt-0.5" />
                <div className="grid gap-1">
                  <div className="flex flex-wrap items-center gap-2 font-medium"><Icon className="size-4" />{title}
                    <Badge variant="secondary" className="font-normal">{time}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{description}</p>
                </div>
              </Label>
            ))}
          </RadioGroup>
          <Button className="justify-self-start" onClick={refresh.onStart}><RefreshCwIcon />Start refresh</Button>
        </>
      )}
    </section>
  );
}

export default function SettingsDialog({ open, onOpenChange, aiStatus, onAiSearchChange, refresh }) {
  const [isConfirmingTurnOff, setIsConfirmingTurnOff] = useState(false);
  const nightMode = useNightMode();
  const isAiOn = !['off', 'stopping'].includes(aiStatus.state);
  const work = describeAiWork(aiStatus);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg" aria-describedby={undefined}>
          <DialogHeader><DialogTitle>Settings</DialogTitle></DialogHeader>
          <section className="flex items-start justify-between gap-4 rounded-lg border p-4">
            <div className="grid gap-1">
              <Label htmlFor="settings-night-mode" className="text-base"><MoonIcon className="size-4" />Night mode</Label>
              <p className="text-muted-foreground">Dark colours for the whole app. The choice is remembered.</p>
            </div>
            <Switch id="settings-night-mode" checked={nightMode} onCheckedChange={setNightMode} />
          </section>
          <section className="grid gap-3 rounded-lg border p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="grid gap-1">
                <Label htmlFor="ai-search" className="text-base"><SparklesIcon className="size-4" />AI search</Label>
                <p className="text-muted-foreground">
                  Finds questions by meaning, even when they share no words with the search. Adds the Hybrid and AI search modes.
                </p>
              </div>
              <Switch id="ai-search" checked={isAiOn} disabled={aiStatus.state === 'stopping'}
                onCheckedChange={isChecked => (isChecked ? onAiSearchChange(true) : setIsConfirmingTurnOff(true))} />
            </div>
            {aiStatus.state === 'off' && (
              <p className="text-xs text-muted-foreground">
                Turning it on downloads the AI model (about 590 MB, from Hugging Face) and builds the AI index on this computer,
                roughly 30–60 minutes. Search and editing keep working meanwhile. Needs about 900 MB of disk space.
              </p>
            )}
            {work && (
              <div className="grid gap-2">
                <span className="flex items-center gap-2">{work.percent == null && <Spinner />}{work.text}</span>
                {work.percent != null && <Progress value={work.percent} />}
              </div>
            )}
            {aiStatus.state === 'ready' && (
              <span className="flex items-center gap-2">
                <CircleCheckIcon className="size-4 text-emerald-600 dark:text-emerald-400" />
                Ready · {formatCount(aiStatus.vectors)} questions in the AI index
              </span>
            )}
            {aiStatus.state === 'error' && (
              <div className="flex items-start gap-2 text-destructive">
                <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
                <span className="flex-1">AI search could not start: {aiStatus.message}</span>
                <Button size="sm" variant="outline" onClick={() => onAiSearchChange(true)}><RotateCcwIcon />Retry</Button>
              </div>
            )}
          </section>
          <RefreshSection refresh={refresh} />
        </DialogContent>
      </Dialog>
      <AlertDialog open={isConfirmingTurnOff} onOpenChange={setIsConfirmingTurnOff}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn off AI search?</AlertDialogTitle>
            <AlertDialogDescription>
              The AI model and the AI index are deleted from this computer, freeing about 900 MB. Turning AI search on again
              downloads and rebuilds them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it on</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => onAiSearchChange(false)}>Turn off and delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
