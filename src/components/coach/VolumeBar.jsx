export default function VolumeBar({ pull, push }) {
  const total = pull + push;
  if (total === 0) return null;

  const pullPct = (pull / total) * 100;
  const pushPct = (push / total) * 100;

  return (
    <div className="space-y-1">
      <div className="flex h-3 rounded-full overflow-hidden bg-gray-100">
        {pull > 0 && (
          <div
            className="bg-pull transition-all"
            style={{ width: `${pullPct}%` }}
          />
        )}
        {push > 0 && (
          <div
            className="bg-push transition-all"
            style={{ width: `${pushPct}%` }}
          />
        )}
      </div>
      <div className="flex justify-between text-xs text-gray-500">
        <span>
          <span className="inline-block w-2 h-2 rounded-full bg-pull mr-1" />
          Pull {pull}
        </span>
        <span>
          Push {push}
          <span className="inline-block w-2 h-2 rounded-full bg-push ml-1" />
        </span>
      </div>
    </div>
  );
}
