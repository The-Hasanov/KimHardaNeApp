import { useEffect, useState } from 'react';
import {
  CircleAlertIcon, DatabaseIcon, DownloadIcon, ExternalLinkIcon, LayersIcon, RefreshCwIcon, SquareIcon, Trash2Icon, ZapIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Spinner } from '@/components/ui/spinner';
import { withoutIpcPrefix } from './gameShared';

const { api } = window;

const REFRESH_MODES = {
  quick: [ZapIcon, 'Quick', 'about 2 min', 'Download what was published since the last refresh.'],
  full: [LayersIcon, 'Full', 'about 20 min', 'Check every package again for changes made on the site.'],
};
const STAGES = {
  list: 'Listing packages', packages: 'Downloading packages', audit: 'Checking authors',
  images: 'Downloading pictures', index: 'Rebuilding the search index', embed: 'Computing AI vectors',
};
const STATES = {
  available: ['Not installed', 'outline'],
  unfinished: ['Not finished', 'secondary'],
  installed: ['Installed', 'secondary'],
};
const formatCount = n => n.toLocaleString('en');
const plural = (n, word) => `${formatCount(n)} ${word}${n === 1 ? '' : 's'}`;

export function useDataSources(onDataChanged) {
  const [sources, setSources] = useState(null);
  const [job, setJob] = useState(null);
  useEffect(() => {
    api.dataSources().then(setSources);
    return api.onDataSourceProgress(progress => setJob(current => current && { ...current, progress }));
  }, []);

  const download = async source => {
    const isInstall = source.state !== 'installed';
    setJob({ sourceId: source.id, progress: { stage: 'start' }, isStopping: false });
    const result = await api.updateDataSource(source.id, source.mode ?? 'quick').catch(e => ({ error: withoutIpcPrefix(e) }));
    setJob(null);
    if (result.dataSources) setSources(result.dataSources);
    onDataChanged();
    const sign = n => (n > 0 ? '+' : '') + formatCount(n);
    const done = result.newRows == null ? '' : `${sign(result.newRows)} questions, ${plural(result.images, 'picture')}`;
    if (result.error) toast.error(`${source.name} could not finish`, { description: result.error + (done && ` (${done})`), duration: 20000 });
    else if (result.cancelled) toast.info('Download stopped', { description: `${done}. Continue it any time from Settings → Data sources.`, duration: 10000 });
    else toast.success(isInstall ? `${source.name} is installed` : `${source.name} is up to date`,
      { description: done + (result.failures ? `, ${plural(result.failures, 'failure')}` : ''), duration: 10000 });
  };
  const stop = () => {
    setJob(current => current && { ...current, isStopping: true });
    api.stopDataSource();
  };
  const remove = async source => {
    try {
      setSources(await api.deleteDataSource(source.id));
      onDataChanged();
      toast.success(`${source.name} is deleted`, { description: 'Install it again any time from Settings → Data sources.' });
    } catch (e) {
      toast.error(`Could not delete ${source.name}`, { description: withoutIpcPrefix(e) });
    }
  };

  const progress = job?.progress;
  const stage = progress && (job.isStopping ? 'Stopping…'
    : `${STAGES[progress.stage] ?? 'Starting'}${progress.total ? ` ${formatCount(progress.done)} / ${formatCount(progress.total)}` : '…'}`);
  const percent = progress?.total ? (progress.done / progress.total) * 100 : null;
  const runningName = job && sources?.find(source => source.id === job.sourceId)?.name;
  return { sources, job, stage, percent, runningName, download, stop, remove };
}

function RefreshModes({ source, mode, onModeChange }) {
  return (
    <RadioGroup value={mode} onValueChange={onModeChange} className="grid-cols-2">
      {source.refreshModes.map(value => {
        const [Icon, title, time, description] = REFRESH_MODES[value];
        return (
          <Label key={value} htmlFor={`refresh-${source.id}-${value}`}
            className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal transition-colors hover:bg-muted/50 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-muted/50">
            <RadioGroupItem id={`refresh-${source.id}-${value}`} value={value} className="mt-0.5" />
            <div className="grid gap-1">
              <div className="flex flex-wrap items-center gap-2 font-medium"><Icon className="size-4" />{title}
                <Badge variant="secondary" className="font-normal">{time}</Badge>
              </div>
              <p className="text-xs text-muted-foreground">{description}</p>
            </div>
          </Label>
        );
      })}
    </RadioGroup>
  );
}

function DataSourceCard({ source, dataSources, onDelete }) {
  const [mode, setMode] = useState(source.refreshModes[0]);
  const { job, stage, percent, download, stop } = dataSources;
  const isRunning = job?.sourceId === source.id;
  const isOtherRunning = !!job && !isRunning;
  const [stateLabel, stateVariant] = isRunning ? [source.state === 'installed' ? 'Refreshing' : 'Installing', 'default'] : STATES[source.state];
  const missingPictures = source.pictures.referenced - source.pictures.saved;
  const facts = source.state !== 'available' && [
    plural(source.questions, 'question'),
    source.pictures.referenced > 0 && `${formatCount(source.pictures.saved)} of ${plural(source.pictures.referenced, 'picture')} saved`,
    source.checkedAt && `checked ${source.checkedAt.slice(0, 10)}`,
  ].filter(Boolean).join(' · ');

  return (
    <section className="grid gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <DatabaseIcon className="size-4 text-muted-foreground" />
        <h3 className="font-medium">{source.name}</h3>
        <Badge variant={stateVariant}>{stateLabel}</Badge>
        <a href={source.website} target="_blank" rel="noreferrer"
          className="ml-auto flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          {source.website.replace(/^https:\/\//, '')}<ExternalLinkIcon className="size-3" />
        </a>
      </div>
      <p className="text-muted-foreground">{source.description}</p>
      {facts && <p className="text-xs text-muted-foreground">{facts}</p>}
      {isRunning ? (
        <div className="grid gap-2">
          <span className="flex items-center gap-2"><Spinner />{stage}</span>
          {percent != null && <Progress value={percent} />}
          <p className="text-xs text-muted-foreground">Keep using the app meanwhile. Stopping keeps what is downloaded, and the next download continues from there.</p>
          <Button variant="outline" className="justify-self-start" onClick={stop} disabled={job.isStopping}>
            <SquareIcon className="fill-current" />Stop download
          </Button>
        </div>
      ) : source.state === 'available' ? (
        <>
          <p className="text-xs text-muted-foreground">
            Downloads every question and picture from the site, one request per second: {source.installTime}. Keep using the app
            meanwhile; you can stop and continue later.
          </p>
          <Button className="justify-self-start" disabled={isOtherRunning} onClick={() => download(source)}><DownloadIcon />Install</Button>
        </>
      ) : (
        <>
          {source.state === 'unfinished' && (
            <p className="flex items-start gap-2 text-amber-700 dark:text-amber-400">
              <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />The download stopped before it finished. Continue to get the rest.
            </p>
          )}
          {source.state === 'installed' && missingPictures > 0 && (
            <p className="text-xs text-muted-foreground">
              {plural(missingPictures, 'picture')} {missingPictures === 1 ? 'is' : 'are'} shown from the site until a refresh saves {missingPictures === 1 ? 'it' : 'them'} on this computer.
            </p>
          )}
          {source.state === 'installed' && <RefreshModes source={source} mode={mode} onModeChange={setMode} />}
          <div className="flex flex-wrap items-center gap-2">
            {source.state === 'installed'
              ? <Button disabled={isOtherRunning} onClick={() => download({ ...source, mode })}><RefreshCwIcon />Refresh</Button>
              : <Button disabled={isOtherRunning} onClick={() => download(source)}><DownloadIcon />Continue install</Button>}
            <Button variant="ghost" className="ml-auto text-muted-foreground hover:text-destructive" disabled={!!job} onClick={() => onDelete(source)}>
              <Trash2Icon />Delete
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

export default function DataSources({ dataSources }) {
  const [sourceToDelete, setSourceToDelete] = useState(null);
  if (!dataSources.sources) return <div className="flex justify-center py-8"><Spinner /></div>;
  return (
    <div className="grid gap-4">
      <p className="text-muted-foreground">
        Question banks this app downloads questions from. Your own questions, lists, games and party data stay whatever you install or delete here.
      </p>
      {dataSources.sources.map(source => (
        <DataSourceCard key={source.id} source={source} dataSources={dataSources} onDelete={setSourceToDelete} />
      ))}
      <AlertDialog open={sourceToDelete != null} onOpenChange={isOpen => !isOpen && setSourceToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {sourceToDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its {plural(sourceToDelete?.questions ?? 0, 'question')} and saved pictures are removed from this computer
              {sourceToDelete?.edited ? `, with your edits to ${plural(sourceToDelete.edited, 'question')}` : ''}. Your own questions,
              lists, games and party data stay. Lists keep their places for these questions and show them again if you install {sourceToDelete?.name} again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => dataSources.remove(sourceToDelete)}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
