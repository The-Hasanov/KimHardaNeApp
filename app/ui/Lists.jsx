import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { cn } from 'cn';
import { ArrowDownIcon, ArrowUpIcon, FileDownIcon, FileUpIcon, ListIcon, PencilIcon, PlayIcon, PlusIcon, SquarePenIcon, Trash2Icon, XIcon } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { exportedMessage, importDetails, questionCountLabel, runTransfer } from './transferMessages';

const { api } = window;
const withLineBreaks = text => (text ?? '').replaceAll('/-/', '\n');
const questionCount = count => `${count} question${count === 1 ? '' : 's'}`;

export function ListNameDialog({ open, title, confirmLabel, initialName = '', onOpenChange, onSubmit }) {
  const [name, setName] = useState(initialName);
  useEffect(() => {
    if (open) setName(initialName);
  }, [open]);
  const submit = e => {
    e.preventDefault();
    if (name.trim()) onSubmit(name.trim());
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm" aria-describedby={undefined}>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Friday game" autoFocus maxLength={80} />
          <DialogFooter>
            <DialogClose asChild><Button type="button" variant="outline">Cancel</Button></DialogClose>
            <Button type="submit" disabled={!name.trim()}>{confirmLabel}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ListQuestionRow({ question, number, isFirst, isLast, hideAnswer, onMove, onRemove, onOpen }) {
  return (
    <li className="group flex gap-3 border-b px-4 py-3">
      <span className="w-6 shrink-0 pt-0.5 text-right text-sm font-medium text-muted-foreground tabular-nums">{number}</span>
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left" title="Open in the editor">
        <div className="truncate text-xs text-muted-foreground">
          {[question.game_name, question.package_name ?? question.tournament_name].filter(Boolean).join(' · ')}
        </div>
        <p className="mt-0.5 line-clamp-2 text-sm whitespace-pre-line">{withLineBreaks(question.text)}</p>
        <p className="mt-0.5 truncate text-sm font-semibold">
          <span className="font-normal text-muted-foreground">→ </span>
          <span className={cn(hideAnswer && 'blur-[5px] select-none')}>{question.answer}</span>
        </p>
      </button>
      <div className="flex shrink-0 items-start gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
        <Button variant="ghost" size="icon-sm" aria-label="Move up" disabled={isFirst} onClick={() => onMove(-1)}><ArrowUpIcon /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="Move down" disabled={isLast} onClick={() => onMove(1)}><ArrowDownIcon /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="Open in the editor" onClick={onOpen}><SquarePenIcon /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="Remove from list" onClick={onRemove}><XIcon /></Button>
      </div>
    </li>
  );
}

export default function Lists({ lists, isVisible, hideAnswers, onListsChanged, onOpenQuestion, onStartGame }) {
  const [selectedListId, setSelectedListId] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [nameDialog, setNameDialog] = useState(null);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const selectedList = lists.find(list => list.id === selectedListId) ?? null;

  useEffect(() => {
    if (!selectedList && lists.length) setSelectedListId(lists[0].id);
  }, [lists, selectedList]);

  const loadQuestions = () => {
    if (selectedListId == null) return setQuestions([]);
    api.listQuestions(selectedListId).then(setQuestions);
  };
  useEffect(loadQuestions, [selectedListId, isVisible]);

  const createList = async name => {
    const listId = await api.createList(name);
    setNameDialog(null);
    await onListsChanged();
    setSelectedListId(listId);
  };
  const renameList = async name => {
    await api.renameList(selectedListId, name);
    setNameDialog(null);
    onListsChanged();
  };
  const deleteList = async () => {
    await api.deleteList(selectedListId);
    toast.success(`Deleted "${selectedList.name}"`);
    setSelectedListId(null);
    onListsChanged();
  };
  const importList = () => runTransfer(api.importList, async ({ listId, summary }) => {
    await onListsChanged();
    setSelectedListId(listId);
    toast.success(`Imported a list of ${questionCountLabel(summary.total)}`, { description: importDetails(summary, { isList: true }) });
  });
  const exportList = () => runTransfer(() => api.exportList(selectedListId), result => {
    const { title, description } = exportedMessage(result);
    toast.success(title, { description });
  });
  const moveQuestion = async (index, direction) => {
    const reordered = [...questions];
    [reordered[index], reordered[index + direction]] = [reordered[index + direction], reordered[index]];
    setQuestions(reordered);
    await api.reorderList(selectedListId, reordered.map(q => q.uid));
  };
  const removeQuestion = async question => {
    setQuestions(current => current.filter(q => q.uid !== question.uid));
    await api.removeFromList(selectedListId, question.uid);
    onListsChanged();
  };

  return (
    <div className="flex h-full">
      <aside className="flex w-64 shrink-0 flex-col border-r">
        <div className="flex h-12 shrink-0 items-center justify-between border-b px-4">
          <span className="text-sm font-medium">Lists</span>
          <div className="flex gap-1">
            <Button size="icon-sm" variant="ghost" onClick={importList} aria-label="Import a list" title="Import a list from a KimHardaNeApp file"><FileUpIcon /></Button>
            <Button size="sm" variant="outline" onClick={() => setNameDialog('create')}><PlusIcon />New list</Button>
          </div>
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto p-2">
          {lists.map(list => (
            <button key={list.id} type="button" onClick={() => setSelectedListId(list.id)}
              className={cn('flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-muted/60',
                list.id === selectedListId && 'bg-muted font-medium')}>
              <ListIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate">{list.name}</span>
              <span className="text-xs text-muted-foreground tabular-nums">{list.count}</span>
            </button>
          ))}
        </nav>
      </aside>

      <section className="min-w-0 flex-1">
        {!selectedList ? (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyMedia variant="icon"><ListIcon /></EmptyMedia>
              <EmptyTitle>No lists yet</EmptyTitle>
              <EmptyDescription>Create a list, then add questions to it from the question editor with “Add to list”.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent className="flex-row justify-center gap-2">
              <Button onClick={() => setNameDialog('create')}><PlusIcon />New list</Button>
              <Button variant="outline" onClick={importList}><FileUpIcon />Import a list</Button>
            </EmptyContent>
          </Empty>
        ) : (
          <div className="flex h-full flex-col">
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2.5">
              <div className="mr-auto min-w-0">
                <h1 className="truncate text-lg font-semibold">{selectedList.name}</h1>
                <p className="text-xs text-muted-foreground">{questionCount(questions.length)}</p>
              </div>
              <Button onClick={() => onStartGame(selectedList.id)} disabled={!questions.length}><PlayIcon />Start game</Button>
              <Button variant="outline" onClick={exportList} disabled={!questions.length} title="Save this list and its questions, with pictures, to a file"><FileDownIcon />Export</Button>
              <Button variant="outline" onClick={() => setNameDialog('rename')}><PencilIcon />Rename</Button>
              <Button variant="outline" onClick={() => setIsConfirmingDelete(true)}><Trash2Icon />Delete</Button>
            </div>
            {questions.length ? (
              <ol className="min-h-0 flex-1 overflow-y-auto">
                {questions.map((question, index) => (
                  <ListQuestionRow key={question.uid} question={question} number={index + 1} hideAnswer={hideAnswers}
                    isFirst={index === 0} isLast={index === questions.length - 1}
                    onMove={direction => moveQuestion(index, direction)} onRemove={() => removeQuestion(question)}
                    onOpen={() => onOpenQuestion(question.uid)} />
                ))}
              </ol>
            ) : (
              <Empty className="flex-1">
                <EmptyHeader>
                  <EmptyTitle>This list is empty</EmptyTitle>
                  <EmptyDescription>Open a question in the Questions tab and use “Add to list”.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </div>
        )}
      </section>

      <ListNameDialog open={nameDialog === 'create'} title="New list" confirmLabel="Create"
        onOpenChange={open => !open && setNameDialog(null)} onSubmit={createList} />
      <ListNameDialog open={nameDialog === 'rename'} title="Rename list" confirmLabel="Rename" initialName={selectedList?.name}
        onOpenChange={open => !open && setNameDialog(null)} onSubmit={renameList} />
      <AlertDialog open={isConfirmingDelete} onOpenChange={setIsConfirmingDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{selectedList?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>The list goes away; its {questionCount(questions.length)} stay in the dataset.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={deleteList}>Delete list</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

