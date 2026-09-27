import { Fragment, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useDefaultLayout } from 'react-resizable-panels';
import { cn } from 'cn';
import {
  DownloadIcon, EyeIcon, FileTextIcon, LayersIcon, PencilIcon, RefreshCwIcon, RotateCcwIcon, SaveIcon, SearchIcon,
  ListIcon, ListPlusIcon, MoonIcon, PlusIcon, SearchXIcon, SettingsIcon, SparklesIcon, SquareIcon, TimerIcon, Trash2Icon, UserIcon, XIcon, ZapIcon,
} from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Game from './Game';
import Lists, { ListNameDialog } from './Lists';
import SettingsDialog, { describeAiWork } from './Settings';
import { setNightMode, useNightMode } from './theme';

const { api } = window;
const FIELDS = [
  ['text', 'Question'], ['answer', 'Answer'], ['accepted_answers', 'Accepted answers'], ['comment', 'Comment'],
  ['note_before', 'Host note (before the question)'], ['rekvizit_text', 'Handout text'], ['sources', 'Sources (one per line)'],
];
const MODES = [
  ['hybrid', 'Hybrid', 'Keyword matches re-ranked with AI similarity'],
  ['keyword', 'Keyword', 'Exact words (BM25), tolerant of small typos'],
  ['ai', 'AI', 'Similar meaning, even without shared words'],
];
const REFRESH_MODES = [
  ['quick', ZapIcon, 'Quick', 'about 2 min', 'Download packages published since the last refresh.'],
  ['full', LayersIcon, 'Full', 'about 20 min', 'Re-check every package for changes made on 3sual.az.'],
];
const STAGES = { list: 'Listing packages', packages: 'Downloading packages', audit: 'Checking authors',
  images: 'Downloading images', index: 'Rebuilding search index', embed: 'Computing AI vectors' };
const PAGE = 100;
const OWN_PACKAGE_ID = 0;
const NEW_QUESTION = { uid: null, package_id: OWN_PACKAGE_ID, game_name: 'My questions' };

const fmt = n => n.toLocaleString('en');
const local = t => t && new Date(t.replace(' ', 'T') + 'Z').toLocaleString();
const plural = (n, word) => `${fmt(n)} ${word}${n === 1 ? '' : 's'}`;
const valueOf = (q, k) => (k === 'sources' ? (q.sources ?? []).join('\n') : q[k] ?? '');
const draftOf = q => Object.fromEntries(FIELDS.map(([k]) => [k, valueOf(q, k)]));
const fold = s => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/ə/g, 'e').replace(/ı/g, 'i');
const TOKENS = /([\n\r\p{Z}\p{P}]+)/u;
const ANSWER_FIELDS = new Set(['answer', 'accepted_answers', 'comment', 'sources']);
const EDITED = 'border-amber-500/40 text-amber-700 dark:text-amber-400';

function Marked({ text, terms }) {
  if (!text || !terms.size) return text;
  return text.split(TOKENS).map((w, i) => (i % 2 === 0 && terms.has(fold(w))
    ? <mark key={i} className="rounded-sm bg-yellow-200 text-inherit dark:bg-yellow-400/25">{w}</mark> : w));
}

function Hit({ h, selected, hideAnswer, onOpen }) {
  const terms = new Set(h.terms);
  const scores = [h.kw != null && `kw ${h.kw.toFixed(1)}`, h.ai != null && `ai ${h.ai.toFixed(3)}`].filter(Boolean).join(' · ');
  return (
    <button id={`hit-${h.uid}`} type="button" onClick={() => onOpen(h.uid)} aria-current={selected || undefined}
      className={cn('block w-full border-b border-l-2 border-l-transparent px-4 py-3 text-left outline-none transition-colors',
        'hover:bg-muted/50 focus-visible:bg-muted/60', selected && 'border-l-primary bg-muted hover:bg-muted')}>
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <span className="shrink-0 font-medium text-foreground/70">{h.game_name}</span>
        <span className="truncate">{[h.package_name, h.theme_name].filter(Boolean).join(' · ')}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {h.edited_at && <Badge variant="outline" className={EDITED} title={`Edited ${local(h.edited_at)}`}><PencilIcon />edited</Badge>}
          {scores && <span className="font-mono text-[11px] tabular-nums" title="Keyword relevance (BM25) · AI similarity (cosine, 0–1)">{scores}</span>}
        </span>
      </div>
      <p className="mt-1 line-clamp-3 whitespace-pre-line text-sm leading-relaxed">
        <Marked text={(h.text ?? '').replaceAll('/-/', '\n')} terms={terms} />
      </p>
      <p className="mt-1 truncate text-sm font-semibold">
        <span className="font-normal text-muted-foreground">→ </span>
        {hideAnswer
          ? <span className="blur-[5px] select-none" aria-label="Answer hidden" title="Answer hidden: open the question to see it">{h.answer}</span>
          : <Marked text={h.answer ?? ''} terms={terms} />}
      </p>
    </button>
  );
}

function Shortcuts() {
  return (
    <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-left text-sm text-muted-foreground">
      <KbdGroup><Kbd>Ctrl</Kbd><Kbd>K</Kbd></KbdGroup><span>Search</span>
      <KbdGroup><Kbd>↑</Kbd><Kbd>↓</Kbd></KbdGroup><span>Move through results</span>
      <KbdGroup><Kbd>Ctrl</Kbd><Kbd>S</Kbd></KbdGroup><span>Save the open question</span>
    </div>
  );
}

function AddToListButton({ lists, listIdsOfQuestion, onToggle, onCreateNew }) {
  const memberCount = listIdsOfQuestion.length;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="ml-auto">
          <ListPlusIcon />{memberCount ? `In ${memberCount} list${memberCount === 1 ? '' : 's'}` : 'Add to list'}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>Add to list</DropdownMenuLabel>
        {lists.map(list => (
          <DropdownMenuCheckboxItem key={list.id} checked={listIdsOfQuestion.includes(list.id)} onSelect={e => e.preventDefault()}
            onCheckedChange={isChecked => onToggle(list, isChecked)}>
            <span className="flex-1 truncate">{list.name}</span>
            <span className="text-xs text-muted-foreground tabular-nums">{list.count}</span>
          </DropdownMenuCheckboxItem>
        ))}
        {lists.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem onSelect={onCreateNew}><PlusIcon />New list…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Editor({ q, draft, setDraft, dirtyKeys, saving, savedAt, concealed, onReveal, onAuthor, onSave, onDiscard, onDelete, onZoom, listControl }) {
  const isOwn = q.package_id === OWN_PACKAGE_ID;
  const isNew = !q.uid;
  const canCreate = !!(draft.text.trim() && draft.answer.trim());
  const path = (q.phase_path ?? []).map(p => p.name).filter(Boolean).join(' › ');
  const authors = (q.authors ?? []).map((a, i) => (
    <Fragment key={a.id ?? i}>
      {i > 0 && ', '}
      {a.id == null ? a.fullname : (
        <button type="button" onClick={() => onAuthor(a)} title={`Show questions by ${a.fullname.trim()}`}
          className="underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:decoration-foreground">
          {a.fullname.trim()}
        </button>
      )}
    </Fragment>
  ));
  const meta = [['Tournament', q.tournament_name], ['Played', q.package_played?.slice(0, 10)], ['Phase', path],
    ['Theme', q.theme_name && q.theme_name + (q.theme_round != null ? ` · round ${q.theme_round}` : '')],
    ['Authors', authors.length > 0 && authors],
    ['Group', q.group_size > 1 && `part ${q.group_index + 1} of ${q.group_size}`],
    ['Edited', local(q.edited_at)], ['ID', q.uid]].filter(([, v]) => v);
  const images = [[q.rekvizit_src, false], [q.source_media_src, concealed]].filter(([src]) => src);
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-5">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Badge variant="secondary">{q.game_name}</Badge>
              {q.edited_at && <Badge variant="outline" className={EDITED}><PencilIcon />edited</Badge>}
              {!isNew && listControl}
            </div>
            <h2 className="text-lg leading-snug font-semibold">
              {isOwn ? (isNew ? 'New question' : 'My question') : <>
                {q.package_name ?? q.tournament_name ?? 'Package'} <span className="font-normal text-muted-foreground">#{q.package_id}</span>
              </>}
            </h2>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
              {meta.map(([k, v]) => (
                <Fragment key={k}><dt className="text-muted-foreground">{k}</dt><dd className="min-w-0 break-words">{v}</dd></Fragment>
              ))}
            </dl>
          </div>
          {images.length > 0 && (
            <div className="flex flex-wrap gap-3">
              {images.map(([src, hide]) => (
                <button key={src} type="button" onClick={() => (hide ? onReveal() : onZoom(src))} title={hide ? 'Answer hidden: click to show' : 'Click to enlarge'}
                  className="cursor-zoom-in overflow-hidden rounded-lg border bg-muted/30 transition-opacity hover:opacity-90">
                  <img src={src} alt="Handout" className={cn('max-h-64 object-contain', hide && 'blur-xl')} />
                </button>
              ))}
            </div>
          )}
          <div className="space-y-5 pb-2">
            {FIELDS.map(([k, label]) => {
              const changed = dirtyKeys.includes(k);
              const hide = concealed && ANSWER_FIELDS.has(k);
              return (
                <div key={k} className="grid gap-2">
                  <Label htmlFor={`f-${k}`}>
                    {label}{changed && <span className="size-1.5 rounded-full bg-amber-500" title="Unsaved change" />}
                    {k === 'answer' && concealed && (
                      <Button variant="outline" size="xs" className="ml-auto" onClick={onReveal}><EyeIcon />Show answer</Button>
                    )}
                  </Label>
                  <div className="relative">
                    <Textarea id={`f-${k}`} value={draft[k]} spellCheck={false}
                      onChange={e => setDraft(d => ({ ...d, [k]: e.target.value }))} onFocus={hide ? onReveal : undefined}
                      className={cn('min-h-10 leading-relaxed', k === 'text' && 'min-h-28',
                        changed && 'border-amber-500 focus-visible:border-amber-500 focus-visible:ring-amber-500/20')} />
                    {hide && (
                      <button type="button" onClick={onReveal}
                        className="absolute inset-0 flex items-center justify-center gap-1.5 rounded-lg bg-background/40 text-xs text-muted-foreground backdrop-blur-md transition-colors hover:text-foreground">
                        <EyeIcon className="size-3.5" />Hidden: click to show
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t px-6 py-3">
        <Button onClick={onSave} disabled={!dirtyKeys.length || saving || (isNew && !canCreate)}>{saving ? <Spinner /> : <SaveIcon />}Save</Button>
        <Button variant="ghost" onClick={onDiscard} disabled={!dirtyKeys.length || saving}><RotateCcwIcon />Discard</Button>
        <span className={cn('ml-2 text-xs text-muted-foreground', dirtyKeys.length && 'text-amber-700 dark:text-amber-400')}>
          {isNew ? (canCreate ? 'Not saved yet' : 'Write the question and its answer, then save')
            : dirtyKeys.length ? `${plural(dirtyKeys.length, 'unsaved change')}`
            : savedAt ? `Saved at ${savedAt.toLocaleTimeString()}` : 'No changes'}
        </span>
        <KbdGroup className="ml-auto"><Kbd>Ctrl</Kbd><Kbd>S</Kbd></KbdGroup>
        {isOwn && !isNew && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" className="text-destructive hover:text-destructive"><Trash2Icon />Delete</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this question?</AlertDialogTitle>
                <AlertDialogDescription>It disappears from search and from your lists. This cannot be undone.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep it</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={onDelete}>Delete</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [info, setInfo] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState('hybrid');
  const [aiStatus, setAiStatus] = useState({ state: 'off' });
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [game, setGame] = useState('all');
  const [edited, setEdited] = useState(false);
  const [withImage, setWithImage] = useState(false);
  const [author, setAuthor] = useState(null);
  const [view, setView] = useState('search');
  const [lists, setLists] = useState([]);
  const [listIdsOfCurrent, setListIdsOfCurrent] = useState([]);
  const [isCreatingListForCurrent, setIsCreatingListForCurrent] = useState(false);
  const [gameListId, setGameListId] = useState(null);
  const [gameSession, setGameSession] = useState(0);
  const nightMode = useNightMode();
  const [hideAnswers, setHideAnswers] = useState(() => localStorage.getItem('hideAnswers') === '1');
  const [revealed, setRevealed] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [sel, setSel] = useState(null);
  const [current, setCurrent] = useState(null);
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [progress, setProgress] = useState(null);
  const [stopping, setStopping] = useState(false);
  const [refreshOpen, setRefreshOpen] = useState(false);
  const [refreshMode, setRefreshMode] = useState('quick');
  const [ask, setAsk] = useState(null);
  const [zoom, setZoom] = useState(null);
  const [update, setUpdate] = useState(null);
  const searchBox = useRef(null);
  const searchSeq = useRef(0);
  const openSeq = useRef(0);
  const onKey = useRef(null);
  const layout = useDefaultLayout({ id: 'split', storage: localStorage });

  const dirtyKeys = current ? FIELDS.map(([k]) => k).filter(k => draft[k] !== valueOf(current, k)) : [];
  const dirty = dirtyKeys.length > 0;
  const hits = results?.hits ?? [];
  const confirmDiscard = () => new Promise(resolve => setAsk(() => resolve));
  const filter = set => v => { set(v); setLimit(PAGE); };
  const isAiReady = aiStatus.state === 'ready';
  const searchMode = isAiReady ? mode : 'keyword';
  const aiWork = describeAiWork(aiStatus);
  const changeAiSearch = isOn => api.setAiSearch(isOn).then(setAiStatus);

  useEffect(() => {
    api.info().then(i => {
      setInfo(i);
      if (i.dataUpdate) {
        const { from, carried, newer } = i.dataUpdate;
        const kept = [carried && `your ${plural(carried, 'edited question')}`, newer && `${plural(newer, 'package')} you refreshed later`].filter(Boolean);
        toast.info(`Data updated from v${from}`, { description: kept.length ? `Kept ${kept.join(' and ')}.` : undefined, duration: 15000 });
      }
    }, e => setLoadError(e.message));
    api.onAi(setAiStatus);
    api.aiStatus().then(setAiStatus);
    api.onRefresh(setProgress);
    api.onUpdate(u => {
      setUpdate(prev => ({ ...prev, ...u }));
      if (u.state === 'ready') toast.info(`Update ${u.version} is ready`, { duration: Infinity, action: { label: 'Restart', onClick: () => onKey.current.restart() } });
    });
    const handler = e => onKey.current(e);
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => { setQuery(q); setLimit(PAGE); }, 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    if (!info) return;
    const my = ++searchSeq.current;
    setSearching(true);
    api.search({ q: query, mode: searchMode, game: game === 'all' ? null : game, edited, withImage, author: author?.id, limit }).then(res => {
      if (my !== searchSeq.current) return;
      setResults(res);
      setSearching(false);
    }, e => {
      if (my !== searchSeq.current) return;
      setSearching(false);
      toast.error('Search failed', { description: e.message });
    });
  }, [info, query, searchMode, game, edited, withImage, author, limit]);

  const refreshLists = () => api.lists().then(setLists);
  useEffect(() => { refreshLists(); }, []);
  useEffect(() => {
    if (current) api.listIdsContaining(current.uid).then(setListIdsOfCurrent);
  }, [current?.uid]);

  async function toggleCurrentInList(list, shouldBeIn) {
    await (shouldBeIn ? api.addToList(list.id, current.uid) : api.removeFromList(list.id, current.uid));
    setListIdsOfCurrent(ids => (shouldBeIn ? [...ids, list.id] : ids.filter(id => id !== list.id)));
    refreshLists();
    toast.success(shouldBeIn ? `Added to "${list.name}"` : `Removed from "${list.name}"`);
  }

  async function createListWithCurrent(name) {
    const listId = await api.createList(name);
    setIsCreatingListForCurrent(false);
    await toggleCurrentInList({ id: listId, name }, true);
  }

  function openInQuestionsTab(uid) {
    setView('search');
    open(uid);
  }

  function startGameWithList(listId) {
    setGameListId(listId);
    setGameSession(session => session + 1);
    setView('game');
  }

  async function open(uid) {
    if (uid === sel) return;
    if (dirty && !(await confirmDiscard())) return;
    const my = ++openSeq.current;
    setSel(uid);
    document.getElementById(`hit-${uid}`)?.scrollIntoView({ block: 'nearest' });
    const question = await api.get(uid);
    if (my !== openSeq.current) return;
    setCurrent(question);
    setDraft(draftOf(question));
    setSavedAt(null);
    setRevealed(false);
  }

  async function startNewQuestion() {
    if (dirty && !(await confirmDiscard())) return;
    openSeq.current++;
    setSel(null);
    setCurrent(NEW_QUESTION);
    setDraft(draftOf(NEW_QUESTION));
    setSavedAt(null);
    setRevealed(true);
    setTimeout(() => document.getElementById('f-text')?.focus());
  }

  async function deleteCurrent() {
    try {
      await api.deleteQuestion(current.uid);
      setCurrent(null);
      setSel(null);
      setInfo(await api.info());
      refreshLists();
      toast.success('Question deleted');
    } catch (e) {
      toast.error('Delete failed', { description: e.message });
    }
  }

  function move(delta) {
    if (!hits.length) return;
    const i = hits.findIndex(h => h.uid === sel);
    const next = hits[i < 0 ? 0 : Math.min(hits.length - 1, Math.max(0, i + delta))];
    const listFocused = document.activeElement?.id?.startsWith('hit-');
    open(next.uid);
    if (listFocused) document.getElementById(`hit-${next.uid}`)?.focus();
  }

  async function save() {
    if (!dirty || saving) return;
    const changed = Object.fromEntries(FIELDS.map(([k]) => [k, draft[k]]).filter(([k, v]) => v !== valueOf(current, k)));
    if (!current.uid && !(draft.text.trim() && draft.answer.trim())) return toast.error('Write the question and its answer first');
    setSaving(true);
    try {
      if (!current.uid) {
        const question = await api.createQuestion(changed);
        setCurrent(question);
        setDraft(draftOf(question));
        setSel(question.uid);
        setSavedAt(new Date());
        setInfo(await api.info());
        toast.success('Question added', { description: 'Pick "My questions" in the game filter to see all of yours.' });
        return;
      }
      const { changed: wrote, question } = await api.save(current.uid, changed);
      setCurrent(question);
      setDraft(draftOf(question));
      setSavedAt(new Date());
      setResults(r => r && { ...r, hits: r.hits.map(h => (h.uid === question.uid
        ? { ...h, text: question.text, answer: question.answer, edited_at: question.edited_at } : h)) });
      toast.success(wrote ? 'Saved' : 'Nothing changed');
    } catch (e) {
      toast.error('Save failed', { description: e.message });
    } finally {
      setSaving(false);
    }
  }

  async function startRefresh() {
    setRefreshOpen(false);
    setProgress({ stage: 'start' });
    const r = await api.refresh(refreshMode).catch(e => ({ error: e.message }));
    setProgress(null);
    setStopping(false);
    const sign = n => (n > 0 ? '+' : '') + fmt(n);
    const done = r.newRows == null ? '' : `${plural(r.newPackages, 'new package')}, ${sign(r.newRows)} questions, ${plural(r.images, 'image')}`;
    if (r.error) toast.error('Refresh failed', { description: r.error + (done && ` (${done})`), duration: 20000 });
    else if (r.cancelled) toast.info('Refresh stopped', { description: `${done}. Refresh again within a day to continue where it stopped.`, duration: 10000 });
    else toast.success('Data refreshed', { description: done + (r.failures ? `, ${plural(r.failures, 'failure')}` : ''), duration: 10000 });
    setInfo(await api.info());
  }

  function stopRefresh() {
    setStopping(true);
    api.cancelRefresh();
  }

  onKey.current = e => {
    if (view !== 'search') return;
    const key = e.key.toLowerCase();
    if (e.ctrlKey && key === 's') {
      e.preventDefault();
      save();
      return;
    }
    if (document.querySelector('[role=dialog], [role=alertdialog]')) return;
    const inSearch = e.target === searchBox.current;
    const typing = !inSearch && e.target.closest?.('input, textarea, select, [role=combobox], [role=listbox]');
    if ((e.ctrlKey && key === 'k') || (key === '/' && !typing && !inSearch)) {
      e.preventDefault();
      searchBox.current?.focus();
      searchBox.current?.select();
    } else if ((key === 'arrowdown' || key === 'arrowup') && !typing
      && !e.target.closest?.('[data-slot=toggle-group], [data-slot=resizable-handle], [role=radiogroup]')) {
      e.preventDefault();
      move(key === 'arrowdown' ? 1 : -1);
    }
  };
  onKey.current.restart = async () => {
    if (!dirty || await confirmDiscard()) api.installUpdate();
  };

  if (!info) {
    return (
      <div className="flex h-screen items-center justify-center gap-3 text-sm text-muted-foreground">
        {loadError ? `Could not load the data: ${loadError}` : <><Spinner />Loading questions and search index…</>}
      </div>
    );
  }

  const summary = results && [
    results.matches != null && (query.trim() ? `${fmt(results.matches)} keyword ${results.matches === 1 ? 'match' : 'matches'}` : plural(results.matches, 'question')),
    query.trim() && searchMode !== 'keyword' && (results.ai ? 'AI ranked' : 'AI unavailable, keyword only'),
    `showing ${fmt(hits.length)}`, `${results.ms} ms`,
  ].filter(Boolean).join(' · ');
  const stage = progress && (stopping ? 'Stopping…'
    : `${STAGES[progress.stage] ?? 'Starting refresh'}${progress.total ? ` ${fmt(progress.done)}/${fmt(progress.total)}` : '…'}`);
  const resetSearch = () => {
    setQ('');
    setQuery('');
    setGame('all');
    setEdited(false);
    setWithImage(false);
    setAuthor(null);
    setLimit(PAGE);
    searchBox.current?.focus();
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <Tabs value={view} onValueChange={setView}>
          <TabsList>
            <TabsTrigger value="search" className="px-2.5"><SearchIcon />Questions</TabsTrigger>
            <TabsTrigger value="lists" className="px-2.5"><ListIcon />Lists</TabsTrigger>
            <TabsTrigger value="game" className="px-2.5"><TimerIcon />Game</TabsTrigger>
          </TabsList>
        </Tabs>
        {view === 'game' && (
          <div className="ml-auto flex items-center gap-2 px-1">
            <MoonIcon className="size-4 text-muted-foreground" />
            <Label htmlFor="night-mode" className="font-normal">Night mode</Label>
            <Switch id="night-mode" checked={nightMode} onCheckedChange={setNightMode} />
          </div>
        )}
        {view === 'search' && <>
        <InputGroup className="min-w-40 flex-1 basis-40">
          <InputGroupAddon><SearchIcon /></InputGroupAddon>
          <InputGroupInput ref={searchBox} value={q} onChange={e => setQ(e.target.value)} autoFocus spellCheck={false}
            placeholder="Search questions, answers, comments…  (e.g. Nizami, futbol klubu)"
            onKeyDown={e => {
              if (e.key === 'Enter') { setQuery(q); setLimit(PAGE); }
              if (e.key === 'Escape') setQ('');
            }} />
          <InputGroupAddon align="inline-end">
            {q ? (
              <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => { setQ(''); searchBox.current?.focus(); }}>
                <XIcon />
              </InputGroupButton>
            ) : <KbdGroup><Kbd>Ctrl</Kbd><Kbd>K</Kbd></KbdGroup>}
          </InputGroupAddon>
        </InputGroup>
        <ToggleGroup type="single" variant="outline" spacing={0} value={searchMode} aria-label="Ranking"
          onValueChange={v => v && (v === 'keyword' || isAiReady ? filter(setMode)(v) : setIsSettingsOpen(true))}>
          {MODES.map(([value, label, hint]) => (
            <Tooltip key={value}>
              <TooltipTrigger asChild>
                <ToggleGroupItem value={value} className={cn('px-3 aria-checked:bg-muted aria-checked:text-foreground', value !== 'keyword' && !isAiReady && 'text-muted-foreground')}>
                  {value === 'ai' && <SparklesIcon />}{label}
                </ToggleGroupItem>
              </TooltipTrigger>
              <TooltipContent>{value === 'keyword' || isAiReady ? hint : 'Turn on AI search in Settings'}</TooltipContent>
            </Tooltip>
          ))}
        </ToggleGroup>
        <Select value={game} onValueChange={filter(setGame)}>
          <SelectTrigger className="w-48" aria-label="Game"><SelectValue /></SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value="all">All games</SelectItem>
            {info.games.map(g => (
              <SelectItem key={g.id} value={String(g.id)}>{g.name}<span className="text-muted-foreground tabular-nums">{fmt(g.n)}</span></SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2 px-1">
          <Switch id="edited" checked={edited} onCheckedChange={filter(setEdited)} />
          <Label htmlFor="edited" className="font-normal">Edited only</Label>
        </div>
        <div className="flex items-center gap-2 px-1">
          <Switch id="with-image" checked={withImage} onCheckedChange={filter(setWithImage)} />
          <Label htmlFor="with-image" className="font-normal">With image</Label>
        </div>
        {progress ? (
          <Button variant="outline" onClick={stopRefresh} disabled={stopping}><SquareIcon className="fill-current" />Stop refresh</Button>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" onClick={() => setRefreshOpen(true)}><RefreshCwIcon />Refresh data</Button>
            </TooltipTrigger>
            <TooltipContent>Download new or changed questions from 3sual.az</TooltipContent>
          </Tooltip>
        )}
        </>}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Settings" className={cn(view === 'lists' && 'ml-auto')}
              onClick={() => setIsSettingsOpen(true)}><SettingsIcon /></Button>
          </TooltipTrigger>
          <TooltipContent>Settings</TooltipContent>
        </Tooltip>
      </header>

      <div className={cn('min-h-0 flex-1', view !== 'search' && 'hidden')}>
      <ResizablePanelGroup orientation="horizontal" className="h-full"
        defaultLayout={layout.defaultLayout} onLayoutChanged={layout.onLayoutChanged}>
        <ResizablePanel id="results" defaultSize="42" minSize={340}>
          <div className="flex h-full flex-col">
            <div className="flex h-9 shrink-0 items-center gap-2 border-b bg-muted/30 pr-4 pl-2 text-xs text-muted-foreground">
              <Button variant="outline" size="xs" className="shrink-0" onClick={startNewQuestion}><PlusIcon />New question</Button>
              {author && (
                <Badge variant="secondary" className="h-6 shrink-0 gap-1 pr-0.5 text-foreground">
                  <UserIcon />{author.fullname.trim()}
                  <button type="button" aria-label="Clear author filter" onClick={() => filter(setAuthor)(null)}
                    className="rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"><XIcon className="size-3" /></button>
                </Badge>
              )}
              {searching && <Spinner className="size-3" />}
              <span className="truncate">{summary ?? 'Searching…'}</span>
              <div className="ml-auto flex shrink-0 items-center gap-2">
                <Switch id="hide-answers" size="sm" checked={hideAnswers} onCheckedChange={v => {
                  setHideAnswers(v);
                  setRevealed(false);
                  localStorage.setItem('hideAnswers', v ? '1' : '0');
                }} />
                <Label htmlFor="hide-answers" className="text-xs font-normal text-muted-foreground">Hide answers</Label>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {hits.map(h => <Hit key={h.uid} h={h} selected={h.uid === sel} hideAnswer={hideAnswers} onOpen={open} />)}
              {results && !hits.length && (
                <Empty className="h-full">
                  <EmptyHeader>
                    <EmptyMedia variant="icon"><SearchXIcon /></EmptyMedia>
                    <EmptyTitle>No questions found</EmptyTitle>
                    <EmptyDescription>
                      {author ? `Only questions by ${author.fullname.trim()} are shown. Clear the search or the author filter.`
                        : edited ? 'Only edited questions are shown. Turn off "Edited only" to search everything.'
                        : withImage ? 'Only questions with a handout image are shown. Turn off "With image" to search everything.'
                        : searchMode === 'keyword' ? `Try fewer words, or ${isAiReady ? 'switch to' : 'turn on'} AI search to match by meaning.`
                          : 'Try different words, or pick another game.'}
                    </EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent><Button variant="outline" size="sm" onClick={resetSearch}>Clear search and filters</Button></EmptyContent>
                </Empty>
              )}
              {hits.length === limit && (
                <div className="p-3">
                  <Button variant="ghost" className="w-full" onClick={() => setLimit(l => l + PAGE)}>Show {PAGE} more</Button>
                </div>
              )}
            </div>
          </div>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel id="editor" minSize={380}>
          {current ? (
            <Editor q={current} draft={draft} setDraft={setDraft} dirtyKeys={dirtyKeys} saving={saving} savedAt={savedAt}
              concealed={hideAnswers && !revealed} onReveal={() => setRevealed(true)} onAuthor={filter(setAuthor)}
              onSave={save} onDiscard={() => setDraft(draftOf(current))} onDelete={deleteCurrent} onZoom={setZoom}
              listControl={<AddToListButton lists={lists} listIdsOfQuestion={listIdsOfCurrent} onToggle={toggleCurrentInList}
                onCreateNew={() => setIsCreatingListForCurrent(true)} />} />
          ) : (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyMedia variant="icon"><FileTextIcon /></EmptyMedia>
                <EmptyTitle>No question open</EmptyTitle>
                <EmptyDescription>Search, then pick a question to edit it, or add your own with New question.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent><Shortcuts /></EmptyContent>
            </Empty>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
      </div>
      <div className={cn('min-h-0 flex-1', view !== 'lists' && 'hidden')}>
        <Lists lists={lists} isVisible={view === 'lists'} hideAnswers={hideAnswers} onListsChanged={refreshLists}
          onOpenQuestion={openInQuestionsTab} onStartGame={startGameWithList} />
      </div>
      <div className={cn('min-h-0 flex-1', view !== 'game' && 'hidden')}>
        <Game key={gameSession} isVisible={view === 'game'} lists={lists} listId={gameListId} onListIdChange={setGameListId}
          isAiReady={isAiReady} onOpenSettings={() => setIsSettingsOpen(true)} />
      </div>
      <SettingsDialog open={isSettingsOpen} onOpenChange={setIsSettingsOpen} aiStatus={aiStatus} onAiSearchChange={changeAiSearch} />
      <ListNameDialog open={isCreatingListForCurrent} title="New list" confirmLabel="Create and add"
        onOpenChange={setIsCreatingListForCurrent} onSubmit={createListWithCurrent} />

      <footer className="flex h-8 shrink-0 items-center gap-4 border-t bg-muted/30 px-3 text-xs text-muted-foreground">
        <span className="truncate">
          {[`v${info.version}`, `${fmt(info.rows)} questions`,
            isAiReady ? `${fmt(aiStatus.vectors)} AI vectors` : { off: 'AI search off', error: 'AI search failed' }[aiStatus.state],
            info.dataDate && `data checked ${info.dataDate.slice(0, 10)}`].filter(Boolean).join(' · ')}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          {aiWork && (
            <button type="button" className="flex items-center gap-2 text-foreground" onClick={() => setIsSettingsOpen(true)}>
              {aiWork.percent == null ? <Spinner className="size-3.5" /> : <SparklesIcon className="size-3.5" />}{aiWork.text}
              {aiWork.percent != null && <Progress value={aiWork.percent} className="w-32" />}
            </button>
          )}
          {progress && (
            <span className="flex items-center gap-2 text-foreground">
              <Spinner className="size-3.5" />{stage}
              {progress.total > 0 && <Progress value={(progress.done / progress.total) * 100} className="w-32" />}
            </span>
          )}
          {update?.state === 'downloading' && (
            <span className="flex items-center gap-1.5"><DownloadIcon className="size-3.5" />Downloading update {update.version} · {update.percent}%</span>
          )}
          {update?.state === 'ready' && (
            <Button size="xs" onClick={() => onKey.current.restart()}>Restart to update to {update.version}</Button>
          )}
        </div>
      </footer>

      <Dialog open={refreshOpen} onOpenChange={setRefreshOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Refresh data from 3sual.az</DialogTitle>
            <DialogDescription>
              The built-in scraper downloads politely, one request per second. Keep searching and editing while it runs;
              your edits are never overwritten.
            </DialogDescription>
          </DialogHeader>
          <RadioGroup value={refreshMode} onValueChange={setRefreshMode}>
            {REFRESH_MODES.map(([value, Icon, title, time, description]) => (
              <Label key={value} htmlFor={`refresh-${value}`}
                className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal transition-colors hover:bg-muted/50 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-muted/50">
                <RadioGroupItem id={`refresh-${value}`} value={value} className="mt-0.5" />
                <div className="grid gap-1">
                  <div className="flex items-center gap-2 font-medium"><Icon className="size-4" />{title}
                    <Badge variant="secondary" className="font-normal">{time}</Badge>
                  </div>
                  <p className="text-muted-foreground">{description}</p>
                </div>
              </Label>
            ))}
          </RadioGroup>
          <DialogFooter>
            <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
            <Button onClick={startRefresh}><RefreshCwIcon />Start refresh</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!ask} onOpenChange={o => { if (!o) { ask?.(false); setAsk(null); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              {plural(dirtyKeys.length, 'field')} changed in this question. Discarding loses {dirtyKeys.length === 1 ? 'it' : 'them'}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => { ask(true); setAsk(null); }}>Discard</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!zoom} onOpenChange={o => !o && setZoom(null)}>
        <DialogContent className="w-auto max-w-[92vw] p-2 sm:max-w-[92vw]" aria-describedby={undefined} showCloseButton={false}>
          <DialogTitle className="sr-only">Handout</DialogTitle>
          {zoom && <img src={zoom} alt="Handout" className="max-h-[86vh] w-[80vw] max-w-5xl rounded-lg object-contain" />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
