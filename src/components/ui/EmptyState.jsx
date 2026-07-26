/**
 * `compact` trims the vertical padding for empties that sit INSIDE a section of
 * a longer page (e.g. the Goals and Stats blocks of the coach Progress tab)
 * rather than standing in for a whole screen. Two page-sized empties stacked on
 * one page is ~8rem of dead scroll.
 */
export default function EmptyState({ message, compact = false }) {
  return (
    <div
      className={`flex flex-col items-center justify-center text-gray-400 ${
        compact ? 'py-6' : 'py-16'
      }`}
    >
      <p className="text-sm">{message}</p>
    </div>
  );
}
