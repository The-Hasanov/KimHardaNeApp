import { useEffect, useState } from 'react';
import { KeyRoundIcon, LockIcon, Trash2Icon, UserRoundIcon } from 'lucide-react';
import { toast } from 'sonner';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

const { api } = window;

const dayLabel = sqliteTime => {
  const date = new Date(`${sqliteTime.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

function DeleteProfileDialog({ profile, onOpenChange, onDelete }) {
  const [withResults, setWithResults] = useState(false);
  useEffect(() => setWithResults(false), [profile]);
  return (
    <AlertDialog open={profile != null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {profile?.name}'s profile?</AlertDialogTitle>
          <AlertDialogDescription>
            Their PIN and preferences are deleted, and the name becomes free for anyone. It comes back as a new profile the next time someone joins with it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {profile?.rounds > 0 && (
          <div className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
            <Switch id="delete-results" checked={withResults} onCheckedChange={setWithResults} />
            <Label htmlFor="delete-results" className="flex-1 font-normal">
              Also remove {profile.name} from the all-time leaderboard ({profile.rounds} {profile.rounds === 1 ? 'round' : 'rounds'})
            </Label>
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Keep</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => onDelete(profile, withResults)}>Delete profile</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default function Profiles() {
  const [profiles, setProfiles] = useState(null);
  const [profileToDelete, setProfileToDelete] = useState(null);
  useEffect(() => {
    api.partyProfiles().then(setProfiles);
  }, []);
  const clearPin = async profile => {
    setProfiles(await api.clearPartyProfilePin(profile.name));
    toast.success(`${profile.name}'s PIN is cleared`, { description: 'Anyone can join with this name until a new PIN is set.' });
  };
  const deleteProfile = async (profile, withResults) => {
    setProfiles(await api.deletePartyProfile(profile.name, { withResults }));
    toast.success(`${profile.name}'s profile is deleted`);
  };
  if (!profiles) return null;
  return (
    <div className="mx-auto max-w-3xl space-y-5 px-6 py-8">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">Player profiles <Badge variant="secondary">{profiles.length}</Badge></h1>
        <p className="text-muted-foreground">
          A profile is made when a player joins a party with a new name. It keeps their PIN and preferences on this computer.
          Players set or change their PIN in Settings on their own phone.
        </p>
      </div>
      {profiles.length ? (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr className="text-left">
                <th className="px-3 py-2 font-medium">Player</th>
                <th className="px-3 py-2 font-medium">PIN</th>
                <th className="px-3 py-2 text-right font-medium">Rounds</th>
                <th className="px-3 py-2 text-right font-medium">Last played</th>
                <th className="w-px px-3 py-2"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {profiles.map(profile => (
                <tr key={profile.name}>
                  <td className="max-w-56 truncate px-3 py-2 font-medium">{profile.name}</td>
                  <td className="px-3 py-2">
                    {profile.has_pin
                      ? <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400"><LockIcon className="size-3.5" />Protected</span>
                      : <span className="text-muted-foreground">None</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{profile.rounds}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap text-muted-foreground">{dayLabel(profile.last_seen_at)}</td>
                  <td className="px-2 py-1.5">
                    <div className="flex justify-end gap-1">
                      {profile.has_pin && (
                        <Button size="sm" variant="ghost" title="Remove the PIN, for example when the player forgot it" onClick={() => clearPin(profile)}>
                          <KeyRoundIcon />Clear PIN
                        </Button>
                      )}
                      <Button size="icon-sm" variant="ghost" className="text-muted-foreground" aria-label={`Delete ${profile.name}'s profile`}
                        title="Delete profile" onClick={() => setProfileToDelete(profile)}>
                        <Trash2Icon />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center">
          <UserRoundIcon className="size-8 text-muted-foreground" />
          <p className="font-medium">No profiles yet</p>
          <p className="max-w-sm text-sm text-muted-foreground">Open a party: every player who joins gets a profile here.</p>
        </div>
      )}
      <DeleteProfileDialog profile={profileToDelete} onOpenChange={isOpen => !isOpen && setProfileToDelete(null)} onDelete={deleteProfile} />
    </div>
  );
}
