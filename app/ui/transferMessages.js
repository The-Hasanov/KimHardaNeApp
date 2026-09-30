import { toast } from 'sonner';

const withIpcPrefixRemoved = error => error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const questions = count => `${count} question${count === 1 ? '' : 's'}`;

export function importDetails({ fromDataset = 0, alreadyYours = 0, added = 0, invalid = 0 }, { isList }) {
  return [
    isList && added && `${questions(added)} added to your questions`,
    alreadyYours && `${questions(alreadyYours)} already in your questions`,
    fromDataset && (isList ? `${questions(fromDataset)} from the question bank` : `${questions(fromDataset)} already in the question bank, skipped`),
    invalid && `${questions(invalid)} without text or answer, skipped`,
  ].filter(Boolean).join(' · ');
}

export async function runTransfer(action, onDone) {
  try {
    const result = await action();
    if (result) await onDone(result);
  } catch (error) {
    toast.error(withIpcPrefixRemoved(error));
  }
}

export const exportedMessage = ({ count, mediaCount, file }) => ({
  title: `Exported ${questions(count)}${mediaCount ? ` and ${mediaCount} media file${mediaCount === 1 ? '' : 's'}` : ''}`, description: file,
});
export { questions as questionCountLabel };
