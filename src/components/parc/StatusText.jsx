const TONE = {
  review: 'text-blue',
  quiet: 'text-amber',
  alert: 'text-red',
};

/**
 * The status that asks for the coach's attention, written at the end of a row
 * (design/parc/components/StatusText): a word and a colour, never a dot
 * alone, never in capitals. One per athlete, the most urgent.
 *
 * `tone`: `review` in `blue` (« 2 à revoir »), `quiet` in `amber`
 * (« Silencieux 9 j »), `alert` in `red` (« Sans programme »).
 */
export default function StatusText({ tone = 'review', className = '', children }) {
  return (
    <span className={`whitespace-nowrap text-right text-[14px] font-bold ${TONE[tone]} ${className}`}>
      {children}
    </span>
  );
}
