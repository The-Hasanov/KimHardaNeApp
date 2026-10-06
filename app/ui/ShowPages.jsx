import { useEffect, useState } from 'react';
import { cn } from 'cn';
import {
  ArrowDownIcon, ArrowUpIcon, CopyIcon, FastForwardIcon, FilmIcon, LockIcon, ImagePlusIcon, LayoutTemplateIcon, PencilIcon, PlusIcon, ClapperboardIcon, TimerIcon, Trash2Icon, TypeIcon, XIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { NumberField, withoutIpcPrefix } from './gameShared';

const { api } = window;
const MAX_BLOCKS = 12;
const NEW_SHOW_PAGE = { title: '', seconds: 10, canPlayersSkip: true, blocks: [{ type: 'text', text: '', isLarge: false }] };

function SlideMedia({ block, className }) {
  return block.type === 'video'
    ? <video key={`${block.src}:${!!block.isLooping}`} src={block.src} className={className} autoPlay muted loop={!!block.isLooping} playsInline />
    : <img src={block.src} alt="" className={className} />;
}

export function ShowPageSlide({ page, className }) {
  const fullscreenBlock = page.blocks.find(block => block.isFullscreen);
  if (fullscreenBlock) {
    return (
      <div className={cn('aspect-video overflow-hidden rounded-lg bg-black', className)}>
        <SlideMedia block={fullscreenBlock} className="size-full object-contain" />
      </div>
    );
  }
  return (
    <div className={cn('flex aspect-video flex-col items-center justify-center gap-[4%] overflow-hidden rounded-lg bg-neutral-950 p-[5%] text-center text-white', className)}>
      {page.title && <p className="text-[clamp(0.9rem,3.2cqw,2.5rem)] leading-tight font-semibold">{page.title}</p>}
      {page.blocks.map((block, index) => (block.src
        ? <SlideMedia key={index} block={block} className="max-h-[45%] min-h-0 max-w-full rounded object-contain" />
        : block.text && (
          <p key={index} className={cn('whitespace-pre-line text-neutral-300', block.isLarge ? 'text-[clamp(0.8rem,2.6cqw,2rem)] font-medium text-white' : 'text-[clamp(0.6rem,1.8cqw,1.4rem)]')}>
            {block.text}
          </p>
        )))}
    </div>
  );
}

function BlockEditor({ block, index, count, onChange, onMove, onRemove }) {
  return (
    <li className="flex gap-3 rounded-lg border p-3">
      <div className="min-w-0 flex-1 space-y-2">
        {block.src ? <>
          <SlideMedia block={block} className="max-h-40 rounded border object-contain" />
          <div className="flex items-center gap-2">
            <Switch id={`block-${index}-fullscreen`} size="sm" checked={!!block.isFullscreen} onCheckedChange={isFullscreen => onChange({ ...block, isFullscreen })} />
            <Label htmlFor={`block-${index}-fullscreen`} className="text-xs font-normal">Fullscreen</Label>
            {block.type === 'video' && <>
              <Switch id={`block-${index}-loop`} size="sm" className="ml-3" checked={!!block.isLooping} onCheckedChange={isLooping => onChange({ ...block, isLooping })} />
              <Label htmlFor={`block-${index}-loop`} className="text-xs font-normal">Loop</Label>
            </>}
          </div>
          {block.isFullscreen && <p className="text-xs text-muted-foreground">Fills the whole screen; the title and the other blocks are hidden.</p>}
        </> : <>
          <Textarea aria-label={`Text ${index + 1}`} value={block.text} rows={3} maxLength={2000} placeholder="Greeting, round rules, a joke…"
            onChange={e => onChange({ ...block, text: e.target.value })} />
          <div className="flex items-center gap-2">
            <Switch id={`block-${index}-large`} size="sm" checked={block.isLarge} onCheckedChange={isLarge => onChange({ ...block, isLarge })} />
            <Label htmlFor={`block-${index}-large`} className="text-xs font-normal">Large text</Label>
          </div>
        </>}
      </div>
      <div className="flex flex-col gap-1">
        <Button size="icon-sm" variant="ghost" aria-label="Move up" title="Move up" disabled={index === 0} onClick={() => onMove(-1)}><ArrowUpIcon /></Button>
        <Button size="icon-sm" variant="ghost" aria-label="Move down" title="Move down" disabled={index === count - 1} onClick={() => onMove(1)}><ArrowDownIcon /></Button>
        <Button size="icon-sm" variant="ghost" className="text-muted-foreground" aria-label="Remove" title="Remove" onClick={onRemove}><XIcon /></Button>
      </div>
    </li>
  );
}

function ShowPageEditor({ page, onOpenChange, onSaved }) {
  const [draft, setDraft] = useState(NEW_SHOW_PAGE);
  const [isSaving, setIsSaving] = useState(false);
  useEffect(() => {
    if (page) setDraft(page);
  }, [page]);
  const setBlocks = blocks => setDraft(current => ({ ...current, blocks }));
  const changeBlock = (index, block) => setBlocks(draft.blocks.map((candidate, position) => (position === index ? block : candidate)));
  const moveBlock = (index, delta) => {
    const blocks = [...draft.blocks];
    [blocks[index], blocks[index + delta]] = [blocks[index + delta], blocks[index]];
    setBlocks(blocks);
  };
  const addMedia = async type => {
    try {
      const block = await api.pickShowPageMedia(type);
      if (block) setBlocks([...draft.blocks, block]);
    } catch (e) {
      toast.error(type === 'video' ? 'Video not added' : 'Picture not added', { description: withoutIpcPrefix(e) });
    }
  };
  const save = async () => {
    setIsSaving(true);
    try {
      const { showPages } = await api.saveShowPage(draft);
      onSaved(showPages);
      toast.success(`${draft.title || 'Show page'} is saved`);
    } catch (e) {
      toast.error('Could not save the show page', { description: withoutIpcPrefix(e) });
    }
    setIsSaving(false);
  };
  const isFull = draft.blocks.length >= MAX_BLOCKS;
  return (
    <Dialog open={page != null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{draft.id ? 'Edit show page' : 'New show page'}</DialogTitle>
          <DialogDescription>It fills the TV and every phone for its seconds, before the round you add it to.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-6 md:grid-cols-[1fr_22rem]">
          <div className="space-y-4">
            <div className="flex flex-wrap items-end gap-4">
              <div className="grid min-w-48 flex-1 gap-2">
                <Label htmlFor="show-page-title">Title</Label>
                <Input id="show-page-title" value={draft.title} maxLength={80} placeholder="Welcome to quiz night!"
                  onChange={e => setDraft({ ...draft, title: e.target.value })} />
              </div>
              <NumberField id="show-page-seconds" label="Seconds on screen" value={draft.seconds} min={3} max={600} step={5}
                onChange={seconds => setDraft({ ...draft, seconds })} />
            </div>
            <div className="flex items-start gap-3 rounded-lg border px-3 py-2.5">
              <Switch id="show-page-skippable" checked={draft.canPlayersSkip !== false} onCheckedChange={canPlayersSkip => setDraft({ ...draft, canPlayersSkip })} className="mt-0.5" />
              <div className="grid gap-0.5">
                <Label htmlFor="show-page-skippable" className="font-normal">Players can skip this page</Label>
                <p className="text-xs text-muted-foreground">
                  {draft.canPlayersSkip !== false ? 'Phones show a Next button; the page moves on when every player skips.' : 'Phones show no Next button. It stays for its seconds, unless you skip it.'}
                </p>
              </div>
            </div>
            <ul className="space-y-2">
              {draft.blocks.map((block, index) => (
                <BlockEditor key={index} block={block} index={index} count={draft.blocks.length} onChange={next => changeBlock(index, next)}
                  onMove={delta => moveBlock(index, delta)} onRemove={() => setBlocks(draft.blocks.filter((_block, position) => position !== index))} />
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" disabled={isFull} onClick={() => setBlocks([...draft.blocks, { type: 'text', text: '', isLarge: false }])}>
                <TypeIcon />Add text
              </Button>
              <Button variant="outline" size="sm" disabled={isFull} onClick={() => addMedia('image')} title="A picture (PNG, JPEG, WebP) or an animated GIF"><ImagePlusIcon />Add picture or GIF</Button>
              <Button variant="outline" size="sm" disabled={isFull} onClick={() => addMedia('video')} title="A video (MP4, WebM)"><FilmIcon />Add video</Button>
            </div>
          </div>
          <div className="space-y-2">
            <Label>Preview</Label>
            <div className="@container"><ShowPageSlide page={draft} /></div>
            <p className="text-xs text-muted-foreground">Phones show the same, sized for a phone.</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={isSaving || (!draft.title.trim() && !draft.blocks.some(block => block.src || block.text?.trim()))}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function ShowPages({ showPages, onShowPagesChange }) {
  const [editing, setEditing] = useState(null);
  const [pageToDelete, setPageToDelete] = useState(null);
  const remove = async page => {
    try {
      onShowPagesChange(await api.deleteShowPage(page.id));
      toast.success(`${page.title || 'Show page'} is deleted`);
    } catch (e) {
      toast.error('Could not delete the show page', { description: withoutIpcPrefix(e) });
    }
  };
  const editable = ({ updated_at, usedBy, ...page }) => page;
  if (!showPages) return null;
  return (
    <div className="mx-auto max-w-3xl space-y-5 px-6 py-8">
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          <h1 className="text-2xl font-semibold">Show pages</h1>
          <p className="text-muted-foreground">
            Pages with text, pictures and videos for the TV and the phones: greet the players, explain a round's rules, anything you like. Add them
            before any party round; each stays on screen for its seconds, and several play one after another.
          </p>
        </div>
        <Button onClick={() => setEditing(NEW_SHOW_PAGE)}><PlusIcon />New show page</Button>
      </div>
      {showPages.length ? (
        <ul className="grid gap-3 sm:grid-cols-2">
          {showPages.map(page => (
            <li key={page.id} className="flex flex-col gap-3 rounded-lg border p-3">
              <div className="@container"><ShowPageSlide page={page} /></div>
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <h2 className="truncate font-medium">{page.title || 'Untitled'}</h2>
                  <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1 whitespace-nowrap"><TimerIcon className="size-3.5" />{page.seconds} s on screen</span>
                    <span className="flex items-center gap-1 whitespace-nowrap">
                      {page.canPlayersSkip ? <><FastForwardIcon className="size-3.5" />Players can skip</> : <><LockIcon className="size-3.5" />Players can't skip</>}
                    </span>
                  </p>
                </div>
                <Button size="icon-sm" variant="ghost" className="text-muted-foreground" aria-label={`Edit ${page.title}`} title="Edit" onClick={() => setEditing(editable(page))}><PencilIcon /></Button>
                <Button size="icon-sm" variant="ghost" className="text-muted-foreground" aria-label={`Duplicate ${page.title}`} title="Duplicate"
                  onClick={() => setEditing({ ...editable(page), id: undefined, title: `${page.title} copy`.slice(0, 80) })}><CopyIcon /></Button>
                <Button size="icon-sm" variant="ghost" className="text-muted-foreground" aria-label={`Delete ${page.title}`}
                  title={page.usedBy?.length ? 'Used by a template, so it cannot be deleted' : 'Delete'} disabled={page.usedBy?.length > 0}
                  onClick={() => setPageToDelete(page)}><Trash2Icon /></Button>
              </div>
              {page.usedBy?.length > 0 && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><LayoutTemplateIcon className="size-3.5" />Used by {page.usedBy.join(', ')}</p>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center">
          <ClapperboardIcon className="size-8 text-muted-foreground" />
          <p className="font-medium">No show pages yet</p>
          <p className="max-w-sm text-sm text-muted-foreground">Make a welcome page or the rules of a round, then add it before a round in Play → Party.</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => setEditing(NEW_SHOW_PAGE)}><PlusIcon />New show page</Button>
        </div>
      )}
      <ShowPageEditor page={editing} onOpenChange={isOpen => !isOpen && setEditing(null)}
        onSaved={pages => { onShowPagesChange(pages); setEditing(null); }} />
      <AlertDialog open={pageToDelete != null} onOpenChange={isOpen => !isOpen && setPageToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {pageToDelete?.title || 'this show page'}?</AlertDialogTitle>
            <AlertDialogDescription>Rounds in your current plan that show it will skip it.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => remove(pageToDelete)}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
