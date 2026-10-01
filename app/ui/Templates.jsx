import { useState } from 'react';
import { ClapperboardIcon, LayoutTemplateIcon, PlayIcon, Trash2Icon, TriangleAlertIcon } from 'lucide-react';
import { toast } from 'sonner';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { withoutIpcPrefix } from './gameShared';
import { roundProblem, roundSummary, showPagesOf } from './RoundPlan';

const { api } = window;

export default function Templates({ templates, onTemplatesChange, lists, pointSystems, sources, showPages, onUse, onPlanNew }) {
  const [templateToDelete, setTemplateToDelete] = useState(null);
  const remove = async template => {
    try {
      onTemplatesChange(await api.deleteGameTemplate(template.id));
      toast.success(`${template.name} is deleted`);
    } catch (e) {
      toast.error(`Could not delete ${template.name}`, { description: withoutIpcPrefix(e) });
    }
  };
  if (!templates || !pointSystems) return null;
  return (
    <div className="mx-auto max-w-3xl space-y-5 px-6 py-8">
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          <h1 className="text-2xl font-semibold">Game templates</h1>
          <p className="text-muted-foreground">
            A template keeps a party's rounds: their show pages, questions, timers and point systems. Plan the rounds under Play in Party mode, then press
            Save as template. Editing a point system or a show page changes every template that uses it.
          </p>
        </div>
        <Button variant="outline" onClick={onPlanNew}><LayoutTemplateIcon />Plan a new game</Button>
      </div>
      {templates.length ? (
        <ul className="space-y-3">
          {templates.map(template => {
            const problems = template.rounds.map(round => roundProblem(round, lists, pointSystems, sources));
            return (
              <li key={template.id} className="space-y-3 rounded-lg border p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="min-w-0 flex-1 truncate font-medium">{template.name}</h2>
                  <Badge variant="secondary">{template.rounds.length} {template.rounds.length === 1 ? 'round' : 'rounds'}</Badge>
                  <Button size="sm" onClick={() => onUse(template)}><PlayIcon />Use</Button>
                  <Button size="icon-sm" variant="ghost" className="text-muted-foreground" aria-label={`Delete ${template.name}`} title="Delete"
                    onClick={() => setTemplateToDelete(template)}><Trash2Icon /></Button>
                </div>
                <ol className="space-y-1 text-sm">
                  {template.rounds.map((round, index) => (
                    <li key={index} className="flex gap-3">
                      <span className="w-16 shrink-0 text-muted-foreground">Round {index + 1}</span>
                      <span className="min-w-0 flex-1">
                        {showPagesOf(round, showPages).length > 0 && (
                          <span className="flex items-center gap-1.5 text-muted-foreground">
                            <ClapperboardIcon className="size-3.5" />{showPagesOf(round, showPages).map(page => page.title || 'Untitled').join(' → ')}
                          </span>
                        )}
                        {roundSummary(round, lists, pointSystems, sources)}
                        {problems[index] && <span className="mt-0.5 flex items-center gap-1.5 text-destructive"><TriangleAlertIcon className="size-3.5" />{problems[index]}</span>}
                      </span>
                    </li>
                  ))}
                </ol>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center">
          <LayoutTemplateIcon className="size-8 text-muted-foreground" />
          <p className="font-medium">No templates yet</p>
          <p className="max-w-sm text-sm text-muted-foreground">Plan the rounds of a party under Play in Party mode, then press Save as template.</p>
        </div>
      )}
      <AlertDialog open={templateToDelete != null} onOpenChange={isOpen => !isOpen && setTemplateToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {templateToDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>Its point systems and lists stay.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => remove(templateToDelete)}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
