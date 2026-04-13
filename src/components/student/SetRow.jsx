import { useToggleSetDone, useSetRpe } from '../../hooks/useSetLogs';
import RpeInput from './RpeInput';

export default function SetRow({ log }) {
  const toggleDone = useToggleSetDone();
  const setRpe = useSetRpe();

  return (
    <div className={`flex items-center gap-3 rounded-lg px-3 py-2 ${
      log.done ? 'bg-success/5' : 'bg-gray-50'
    }`}>
      <button
        onClick={() => toggleDone.mutate({ logId: log.id, done: !log.done })}
        className={`w-8 h-8 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${
          log.done
            ? 'bg-success border-success text-white'
            : 'border-gray-300 text-transparent hover:border-success/50'
        }`}
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
        </svg>
      </button>

      <span className="text-sm text-gray-600 font-medium w-12">
        Set {log.set_number}
      </span>

      <div className="flex-1">
        <RpeInput
          value={log.rpe}
          onChange={(rpe) => setRpe.mutate({ logId: log.id, rpe })}
        />
      </div>
    </div>
  );
}
