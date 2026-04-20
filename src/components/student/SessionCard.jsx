import { useState } from 'react';
import { formatSlotPrescription } from '../../lib/volume';

function SlotSummary({ slot }) {
  const ex = slot.exercise;
  if (!ex) return null;
  return (
    <div className="flex items-center gap-2 text-xs text-gray-600">
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${
          ex.type === 'pull' ? 'bg-pull' : 'bg-push'
        }`}
      />
      <span className="font-medium text-gray-800 truncate">{ex.name}</span>
      <span className="text-gray-400 shrink-0">
        {formatSlotPrescription(slot)}
        {slot.weight_kg ? ` @ ${slot.weight_kg} kg` : ''}
      </span>
    </div>
  );
}

/**
 * Expandable session card showing the full exercise list and a Start button.
 * Used on the student Sessions page and above Upcoming on Home.
 */
export default function SessionCard({
  session,
  confirmed,
  archived,
  onStart,
  defaultOpen = false,
  subtitle,
}) {
  const [open, setOpen] = useState(defaultOpen);
  const slots = session.exercise_slots || [];

  return (
    <div className="bg-white rounded-xl shadow-sm overflow-hidden">
      <button
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-gray-50 transition-colors"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <div className="min-w-0">
          <p className={`text-sm font-medium truncate ${archived ? 'text-gray-400' : 'text-gray-900'}`}>
            {session.title || `Session ${session.sort_order + 1}`}
          </p>
          <p className="text-xs text-gray-400 mt-0.5">
            {subtitle ? <span>{subtitle} · </span> : null}
            {slots.length} exercise{slots.length !== 1 ? 's' : ''}
            {confirmed && <span className="ml-2 text-green-600 font-medium">· Done</span>}
            {archived && <span className="ml-2 text-amber-600 font-medium">· Archived</span>}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {confirmed ? (
            <svg className="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
            </svg>
          ) : archived ? (
            <span className="text-xs font-medium text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">
              Archived
            </span>
          ) : (
            <span className="text-xs font-medium text-primary bg-primary/10 px-2 py-0.5 rounded-full">
              Start
            </span>
          )}
          <svg
            className={`w-4 h-4 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      {open && (
        <div className="border-t border-gray-100">
          {slots.length === 0 ? (
            <p className="px-4 py-3 text-xs text-gray-400">No exercises assigned yet.</p>
          ) : (
            <div className="px-4 py-3 space-y-2">
              {slots.map((slot) => (
                <SlotSummary key={slot.id} slot={slot} />
              ))}
            </div>
          )}
          {!archived && (
            <div className="px-4 pb-3">
              <button
                onClick={onStart}
                className="w-full bg-primary text-white rounded-lg py-2 text-sm font-semibold hover:opacity-90 transition-opacity"
              >
                {confirmed ? 'Review session' : 'Start session'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
