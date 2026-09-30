import { Fragment, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useDefaultLayout } from 'react-resizable-panels';
import { cn } from 'cn';
import {
  DatabaseIcon, DownloadIcon, EyeIcon, FileDownIcon, FileUpIcon, FileTextIcon, ImagePlusIcon, PencilIcon, RotateCcwIcon, SaveIcon, SearchIcon,
  ListIcon, ListPlusIcon, MoonIcon, NotebookPenIcon, PlusIcon, SearchXIcon, SettingsIcon, SparklesIcon, TimerIcon, Trash2Icon, UserIcon, XIcon,
} from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Toggle } from '@/components/ui/toggle';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Game from './Game';
import Lists, { ListNameDialog } from './Lists';
import SettingsDialog, { describeAiWork } from './Settings';
import { useDataSources } from './DataSources';
import { setNightMode, useNightMode } from './theme';
import { GamePicker, Media, withoutIpcPrefix } from './gameShared';
import { exportedMessage, importDetails, questionCountLabel, runTransfer } from './transferMessages';

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
const PAGE = 100;
const VIEWS = [['search', SearchIcon, 'Search'], ['mine', NotebookPenIcon, 'Custom'], ['lists', ListIcon, 'Lists'], ['game', TimerIcon, 'Game']];
const OWN_SOURCE_ID = 'own';
const OWN_GAMES = ['own:0'];
const NEW_QUESTION = { uid: null, source_id: OWN_SOURCE_ID, game_name: 'My questions' };
const PICTURES = [
  ['rekvizit_url', 'rekvizit_src', 'rekvizit_kind', 'Handout', 'shown with the question'],
  ['source_media_url', 'source_media_src', 'source_media_kind', 'Answer media', 'shown with the answer'],
];

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
      <KbdGroup><Kbd>Ctrl</Kbd><Kbd>1</Kbd>–<Kbd>4</Kbd></KbdGroup><span>Switch tabs</span>
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

function OwnPictures({ q, concealed, onReveal, onZoom, onPick, onRemove }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {PICTURES.map(([column, srcKey, kindKey, label, hint]) => {
        const src = q[srcKey];
        const kind = q[kindKey];
        const hide = concealed && column === 'source_media_url';
        return (
          <div key={column} className="grid content-start gap-2">
            <Label>{label}<span className="font-normal text-muted-foreground">{hint}</span></Label>
            {src && kind !== 'image' && (hide
              ? <Button variant="outline" size="sm" className="justify-self-start" onClick={onReveal}><EyeIcon />Show the answer {kind}</Button>
              : <Media src={src} kind={kind} alt={label} className="max-h-48 w-full" />)}
            {src && kind === 'image' && (
              <button type="button" onClick={() => (hide ? onReveal() : onZoom(src))} title={hide ? 'Answer hidden: click to show' : 'Click to enlarge'}
                className="cursor-zoom-in overflow-hidden rounded-lg border bg-muted/30 transition-opacity hover:opacity-90">
                <img src={src} alt={label} className={cn('max-h-48 w-full object-contain', hide && 'blur-xl')} />
              </button>
            )}
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => onPick(column)} title="A picture (PNG, JPEG, GIF, WebP), a video (MP4, WebM) or audio (MP3, M4A, WAV, OGG)"><ImagePlusIcon />{src ? 'Replace' : 'Add picture, video or audio'}</Button>
              {src && <Button variant="ghost" size="sm" onClick={() => onRemove(column)}><XIcon />Remove</Button>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Editor({ q, draft, setDraft, dirtyKeys, saving, savedAt, concealed, onReveal, onAuthor, onSave, onDiscard, onDelete, onZoom, onPickPicture, onRemovePicture, listControl, sourceName }) {
  const isOwn = q.source_id === OWN_SOURCE_ID;
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
              <Badge variant="secondary">{[!isOwn && sourceName, q.game_name].filter(Boolean).join(' · ')}</Badge>
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
          {isOwn ? (
            <OwnPictures q={q} concealed={concealed} onReveal={onReveal} onZoom={onZoom} onPick={onPickPicture} onRemove={onRemovePicture} />
          ) : images.length > 0 && (
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
  const [settingsTab, setSettingsTab] = useState('general');
  const [games, setGames] = useState([]);
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
  const isMine = view === 'mine';
  const isBrowsing = view === 'search' || isMine;
  const aiWork = describeAiWork(aiStatus);
  const changeAiSearch = isOn => api.setAiSearch(isOn).then(setAiStatus);
  const dataSources = useDataSources(() => {
    api.info().then(setInfo);
    refreshLists();
  });
  const openSettings = tab => {
    setSettingsTab(tab);
    setIsSettingsOpen(true);
  };

  useEffect(() => {
    api.info().then(setInfo, e => setLoadError(e.message));
    api.onAi(setAiStatus);
    api.aiStatus().then(setAiStatus);
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
    const request = isMine ? { q: '', mode: 'keyword', games: OWN_GAMES, limit }
      : { q: query, mode: searchMode, games, edited, withImage, author: author?.id, limit };
    api.search(request).then(res => {
      if (my !== searchSeq.current) return;
      setResults(res);
      setSearching(false);
    }, e => {
      if (my !== searchSeq.current) return;
      setSearching(false);
      toast.error('Search failed', { description: e.message });
    });
  }, [info, isMine, query, searchMode, games, edited, withImage, author, limit]);

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

  const importOwnQuestions = () => runTransfer(api.importOwnQuestions, async summary => {
    setInfo(await api.info());
    const details = importDetails(summary, { isList: false });
    if (summary.added) toast.success(`Imported ${questionCountLabel(summary.added)}`, { description: details });
    else toast.info('Nothing new to import', { description: details });
  });
  const exportOwnQuestions = () => runTransfer(api.exportOwnQuestions, result => {
    const { title, description } = exportedMessage(result);
    toast.success(title, { description });
  });

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

  async function changePicture(column, shouldRemove) {
    const uid = current.uid ?? (await save())?.uid;
    if (!uid) return;
    try {
      const question = await (shouldRemove ? api.removeQuestionImage(uid, column) : api.pickQuestionImage(uid, column));
      if (question) setCurrent(question);
    } catch (e) {
      toast.error('Picture not saved', { description: withoutIpcPrefix(e) });
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
    if (saving) return;
    if (!current.uid && !(draft.text.trim() && draft.answer.trim())) return toast.error('Write the question and its answer first');
    if (!dirty) return;
    const changed = Object.fromEntries(FIELDS.map(([k]) => [k, draft[k]]).filter(([k, v]) => v !== valueOf(current, k)));
    setSaving(true);
    try {
      if (!current.uid) {
        const question = await api.createQuestion(changed);
        setCurrent(question);
        setDraft(draftOf(question));
        setSel(question.uid);
        setSavedAt(new Date());
        setInfo(await api.info());
        toast.success('Question added');
        return question;
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

  onKey.current = e => {
    const viewAtKey = e.ctrlKey && !e.altKey && VIEWS[Number(e.key) - 1];
    if (viewAtKey) {
      e.preventDefault();
      setView(viewAtKey[0]);
      return;
    }
    if (!isBrowsing) return;
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

  const isSearching = !isMine && !!query.trim();
  const summary = results && [
    results.matches != null && (isSearching ? `${fmt(results.matches)} keyword ${results.matches === 1 ? 'match' : 'matches'}` : plural(results.matches, 'question')),
    isSearching && searchMode !== 'keyword' && (results.ai ? 'AI ranked' : 'AI unavailable, keyword only'),
    `showing ${fmt(hits.length)}`, `${results.ms} ms`,
  ].filter(Boolean).join(' · ');
  const resetSearch = () => {
    setQ('');
    setQuery('');
    setGames([]);
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
            {VIEWS.map(([value, Icon, label], index) => (
              <Tooltip key={value}>
                <TooltipTrigger asChild>
                  <TabsTrigger value={value} className="px-2.5"><Icon />{label}</TabsTrigger>
                </TooltipTrigger>
                <TooltipContent className="flex items-center gap-2">Switch with<KbdGroup><Kbd>Ctrl</Kbd><Kbd>{index + 1}</Kbd></KbdGroup></TooltipContent>
              </Tooltip>
            ))}
          </TabsList>
        </Tabs>
        {view === 'game' && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Toggle aria-label="Night mode" className="ml-auto px-2" pressed={nightMode} onPressedChange={setNightMode}><MoonIcon /></Toggle>
            </TooltipTrigger>
            <TooltipContent>Night mode</TooltipContent>
          </Tooltip>
        )}
        {isMine && <>
          <Button variant="ghost" className="ml-auto" onClick={importOwnQuestions} title="Add questions from a KimHardaNeApp file"><FileUpIcon />Import</Button>
          <Button variant="ghost" onClick={exportOwnQuestions} disabled={!info?.ownCount} title="Save your questions, with their pictures, to a file"><FileDownIcon />Export</Button>
          <Button variant="outline" onClick={startNewQuestion}><PlusIcon />New question</Button>
        </>}
        {view === 'search' && <>
        <InputGroup className="min-w-40 flex-1 basis-40">
          <InputGroupAddon><SearchIcon /></InputGroupAddon>
          <InputGroupInput ref={searchBox} value={q} onChange={e => setQ(e.target.value)} autoFocus spellCheck={false}
            placeholder="Search questions, answers, comments…"
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
        <Select value={searchMode} onValueChange={v => (v === 'keyword' || isAiReady ? filter(setMode)(v) : openSettings('general'))}>
          <SelectTrigger className="w-28" aria-label="Ranking"><SelectValue /></SelectTrigger>
          <SelectContent position="popper">
            {MODES.map(([value, label, hint]) => (
              <SelectItem key={value} value={value} title={value === 'keyword' || isAiReady ? hint : 'Turn on AI search in Settings'}
                className={cn(value !== 'keyword' && !isAiReady && 'text-muted-foreground')}>
                {value === 'ai' && <SparklesIcon />}{label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <GamePicker id="search-games" label={null} sources={info.questionSources} games={games} onGamesChange={filter(setGames)} className="w-52" />
        <div className="flex items-center gap-2 px-1">
          <Switch id="edited" checked={edited} onCheckedChange={filter(setEdited)} />
          <Label htmlFor="edited" className="font-normal">Edited only</Label>
        </div>
        <div className="flex items-center gap-2 px-1">
          <Switch id="with-image" checked={withImage} onCheckedChange={filter(setWithImage)} />
          <Label htmlFor="with-image" className="font-normal">With image</Label>
        </div>
        </>}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Settings" className={cn(view === 'lists' && 'ml-auto')}
              onClick={() => openSettings(settingsTab)}><SettingsIcon /></Button>
          </TooltipTrigger>
          <TooltipContent>Settings</TooltipContent>
        </Tooltip>
      </header>

      <div className={cn('min-h-0 flex-1', !isBrowsing && 'hidden')}>
      <ResizablePanelGroup orientation="horizontal" className="h-full"
        defaultLayout={layout.defaultLayout} onLayoutChanged={layout.onLayoutChanged}>
        <ResizablePanel id="results" defaultSize="42" minSize={340}>
          <div className="flex h-full flex-col">
            <div className="flex h-9 shrink-0 items-center gap-2 border-b bg-muted/30 px-4 text-xs text-muted-foreground">
              {author && !isMine && (
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
              {results && !hits.length && isMine && (
                <Empty className="h-full">
                  <EmptyHeader>
                    <EmptyMedia variant="icon"><NotebookPenIcon /></EmptyMedia>
                    <EmptyTitle>No questions of your own yet</EmptyTitle>
                    <EmptyDescription>Write one with New question. They show up in search and lists like every other question.</EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent><Button variant="outline" size="sm" onClick={startNewQuestion}><PlusIcon />New question</Button></EmptyContent>
                </Empty>
              )}
              {results && !hits.length && !isMine && info.rows === 0 && (
                <Empty className="h-full">
                  <EmptyHeader>
                    <EmptyMedia variant="icon"><DatabaseIcon /></EmptyMedia>
                    <EmptyTitle>No questions yet</EmptyTitle>
                    <EmptyDescription>Install a question bank from Data sources, or write your own questions in Custom.</EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent className="flex-row justify-center">
                    <Button size="sm" onClick={() => openSettings('data-sources')}><DatabaseIcon />Open data sources</Button>
                    <Button variant="outline" size="sm" onClick={() => setView('mine')}><NotebookPenIcon />Write a question</Button>
                  </EmptyContent>
                </Empty>
              )}
              {results && !hits.length && !isMine && info.rows > 0 && (
                <Empty className="h-full">
                  <EmptyHeader>
                    <EmptyMedia variant="icon"><SearchXIcon /></EmptyMedia>
                    <EmptyTitle>No questions found</EmptyTitle>
                    <EmptyDescription>
                      {author ? `Only questions by ${author.fullname.trim()} are shown. Clear the search or the author filter.`
                        : edited ? 'Only edited questions are shown. Turn off "Edited only" to search everything.'
                        : withImage ? 'Only questions with a handout image are shown. Turn off "With image" to search everything.'
                        : searchMode === 'keyword' ? `Try fewer words, or ${isAiReady ? 'switch to' : 'turn on'} AI search to match by meaning.`
                          : 'Try different words, or pick other questions.'}
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
            <Editor q={current} sourceName={info.questionSources.find(source => source.id === current.source_id)?.name} draft={draft} setDraft={setDraft} dirtyKeys={dirtyKeys} saving={saving} savedAt={savedAt}
              concealed={hideAnswers && !revealed} onReveal={() => setRevealed(true)} onAuthor={filter(setAuthor)}
              onSave={save} onDiscard={() => setDraft(draftOf(current))} onDelete={deleteCurrent} onZoom={setZoom}
              onPickPicture={column => changePicture(column, false)} onRemovePicture={column => changePicture(column, true)}
              listControl={<AddToListButton lists={lists} listIdsOfQuestion={listIdsOfCurrent} onToggle={toggleCurrentInList}
                onCreateNew={() => setIsCreatingListForCurrent(true)} />} />
          ) : (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyMedia variant="icon"><FileTextIcon /></EmptyMedia>
                <EmptyTitle>No question open</EmptyTitle>
                <EmptyDescription>{isMine ? 'Pick one of your questions, or write a new one.' : 'Search, then pick a question to edit it.'}</EmptyDescription>
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
        <Game key={gameSession} isVisible={view === 'game'} lists={lists} sources={info.questionSources} listId={gameListId} onListIdChange={setGameListId}
          isAiReady={isAiReady} onOpenSettings={() => openSettings('general')} />
      </div>
      <SettingsDialog open={isSettingsOpen} onOpenChange={setIsSettingsOpen} tab={settingsTab} onTabChange={setSettingsTab}
        aiStatus={aiStatus} onAiSearchChange={changeAiSearch} dataSources={dataSources} />
      <ListNameDialog open={isCreatingListForCurrent} title="New list" confirmLabel="Create and add"
        onOpenChange={setIsCreatingListForCurrent} onSubmit={createListWithCurrent} />

      <footer className="flex h-8 shrink-0 items-center gap-4 border-t bg-muted/30 px-3 text-xs text-muted-foreground">
        <span className="truncate">
          {[`v${info.version}`, `${fmt(info.rows)} questions`,
            isAiReady ? `${fmt(aiStatus.vectors)} AI vectors` : { off: 'AI search off', error: 'AI search failed' }[aiStatus.state]].filter(Boolean).join(' · ')}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          {aiWork && (
            <button type="button" className="flex items-center gap-2 text-foreground" onClick={() => openSettings('general')}>
              {aiWork.percent == null ? <Spinner className="size-3.5" /> : <SparklesIcon className="size-3.5" />}{aiWork.text}
              {aiWork.percent != null && <Progress value={aiWork.percent} className="w-32" />}
            </button>
          )}
          {dataSources.job && (
            <button type="button" className="flex items-center gap-2 text-foreground" onClick={() => openSettings('data-sources')}>
              <Spinner className="size-3.5" />{dataSources.runningName}: {dataSources.stage}
              {dataSources.percent != null && <Progress value={dataSources.percent} className="w-32" />}
            </button>
          )}
          {update?.state === 'downloading' && (
            <span className="flex items-center gap-1.5"><DownloadIcon className="size-3.5" />Downloading update {update.version} · {update.percent}%</span>
          )}
          {update?.state === 'ready' && (
            <Button size="xs" onClick={() => onKey.current.restart()}>Restart to update to {update.version}</Button>
          )}
        </div>
      </footer>

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
