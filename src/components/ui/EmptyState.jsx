// A sentence where a list would be, when it holds nothing.
export default function EmptyState({ message, compact = false }) {
  return (
    <div className={`flex flex-col items-center justify-center ${compact ? 'py-6' : 'py-16'}`}>
      <p className="pk-body m-0 text-center text-ink-2">{message}</p>
    </div>
  );
}
