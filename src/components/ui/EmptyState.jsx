export default function EmptyState({ message }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-gray-400">
      <p className="text-sm">{message}</p>
    </div>
  );
}
