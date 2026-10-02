import { useState } from 'react';
import { CircleAlertIcon, CircleCheckIcon, DatabaseIcon, MoonIcon, RotateCcwIcon, SettingsIcon, SparklesIcon, Trash2Icon } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import DataSources from './DataSources';
import { setNightMode, useNightMode } from './theme';

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
      return { text: 'Turning off AI search…' };
    case 'removing':
      return { text: 'Deleting the AI model and index…' };
    default:
      return null;
  }
}

export default function SettingsDialog({ open, onOpenChange, tab, onTabChange, aiStatus, onAiSearchChange, onRemoveAiFiles, dataSources }) {
  const [isConfirmingRemoval, setIsConfirmingRemoval] = useState(false);
  const nightMode = useNightMode();
  const isAiOn = !['off', 'stopping', 'removing'].includes(aiStatus.state);
  const hasAiFiles = aiStatus.state === 'off' && aiStatus.storedBytes > 0;
  const work = describeAiWork(aiStatus);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg" aria-describedby={undefined}>
          <DialogHeader><DialogTitle>Settings</DialogTitle></DialogHeader>
          <Tabs value={tab} onValueChange={onTabChange} className="gap-4">
            <TabsList className="w-full">
              <TabsTrigger value="general"><SettingsIcon />General</TabsTrigger>
              <TabsTrigger value="data-sources"><DatabaseIcon />Data sources</TabsTrigger>
            </TabsList>
            <TabsContent value="general" className="grid gap-4">
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
                  <Switch id="ai-search" checked={isAiOn} disabled={['stopping', 'removing'].includes(aiStatus.state)} onCheckedChange={onAiSearchChange} />
                </div>
                {hasAiFiles && (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="flex-1 text-xs text-muted-foreground">
                      The AI model and index stay on this computer ({megabytes(aiStatus.storedBytes)} MB), so turning AI search on again is quick.
                    </p>
                    <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setIsConfirmingRemoval(true)}>
                      <Trash2Icon />Delete AI files
                    </Button>
                  </div>
                )}
                {aiStatus.state === 'off' && !hasAiFiles && (
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
            </TabsContent>
            <TabsContent value="data-sources">
              <DataSources dataSources={dataSources} />
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
      <AlertDialog open={isConfirmingRemoval} onOpenChange={setIsConfirmingRemoval}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete the AI files?</AlertDialogTitle>
            <AlertDialogDescription>
              The AI model and the AI index are deleted from this computer, freeing about {megabytes(aiStatus.storedBytes ?? 0)} MB. Turning AI
              search on again downloads the model (about 590 MB) and rebuilds the index, roughly 30–60 minutes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep them</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onRemoveAiFiles}>Delete AI files</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
