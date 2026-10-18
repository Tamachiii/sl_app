import { useId } from 'react';

/**
 * A free text, signed (design/parc/components/CoachNote): the coach's
 * instruction on an exercise, or an athlete's note on a set. The title says
 * who speaks — « Note du coach » in `blue` (`from="coach"`), « Note de Léa,
 * série 2 » in `ink` (`from="athlete"`) — and the text is shown whole, as it
 * was written. No coloured edge: the title is enough.
 */
export default function CoachNote({ title, from = 'coach', className = '', children }) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className={`rounded-group bg-surface p-4 ${className}`}>
      <h3
        id={titleId}
        className={`text-[15px] font-bold leading-[1.4] ${from === 'coach' ? 'text-blue' : 'text-ink'}`}
      >
        {title}
      </h3>
      <div className="pk-body mt-1.5 whitespace-pre-line break-words">{children}</div>
    </section>
  );
}
