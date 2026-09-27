import { useEffect, useRef, useState } from 'react';
import { cn } from 'cn';

export const WARNING_AT_SECONDS_LEFT = 10;
export const KEY_HINT_ON_PRIMARY_BUTTON = 'bg-primary-foreground/15 text-primary-foreground';

export const formatClock = seconds => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
export const withLineBreaks = text => (text ?? '').replaceAll('/-/', '\n');

function playTone(durationMs, frequencyHz) {
  const audio = (playTone.context ??= new AudioContext());
  const oscillator = audio.createOscillator();
  const volume = audio.createGain();
  oscillator.frequency.value = frequencyHz;
  volume.gain.value = 0.2;
  oscillator.connect(volume).connect(audio.destination);
  oscillator.start();
  oscillator.stop(audio.currentTime + durationMs / 1000);
}
export const playTenSecondsLeftTone = () => playTone(150, 660);
export const playTimeUpTone = () => playTone(700, 440);

export function useCountdown(endsAt, onFinish) {
  const [secondsLeft, setSecondsLeft] = useState(0);
  const latestOnFinish = useRef(onFinish);
  latestOnFinish.current = onFinish;
  useEffect(() => {
    if (!endsAt) return;
    const tick = () => {
      const remaining = (endsAt - Date.now()) / 1000;
      if (remaining > 0) return setSecondsLeft(remaining);
      clearInterval(countdown);
      setSecondsLeft(0);
      latestOnFinish.current();
    };
    const countdown = setInterval(tick, 100);
    tick();
    return () => clearInterval(countdown);
  }, [endsAt]);
  return secondsLeft;
}

export function QuestionOnScreen({ question, textClassName = 'text-3xl', imageClassName = 'max-h-[28rem]' }) {
  const credits = [question.package_name ?? question.tournament_name, (question.authors ?? []).map(a => a.fullname.trim()).join(', ')];
  return (
    <div className="space-y-6">
      {question.note_before && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
          <span className="font-medium">Before the question: </span>{question.note_before}
        </div>
      )}
      <p className={cn('leading-snug font-medium whitespace-pre-line', textClassName)}>{withLineBreaks(question.text)}</p>
      {(question.rekvizit_src || question.rekvizit_text) && (
        <div className="space-y-2">
          <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Handout</div>
          {question.rekvizit_src && <img src={question.rekvizit_src} alt="Handout" className={cn('rounded-lg border object-contain', imageClassName)} />}
          {question.rekvizit_text && <p className="whitespace-pre-line">{question.rekvizit_text}</p>}
        </div>
      )}
      <p className="text-sm text-muted-foreground">{credits.filter(Boolean).join(' · ')}</p>
    </div>
  );
}

export function NextQuestionNumber({ number, total }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-3 px-8 py-10 text-center animate-in fade-in-0">
      <p className="text-lg font-medium text-muted-foreground">Question</p>
      <p className="text-[12rem] leading-none font-semibold tabular-nums">{number}</p>
      <p className="text-lg text-muted-foreground">of {total}</p>
    </div>
  );
}
