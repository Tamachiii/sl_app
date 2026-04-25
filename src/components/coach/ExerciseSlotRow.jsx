import { useState, useEffect, useMemo } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import ConfirmDialog from '../ui/ConfirmDialog';
import { isSlotUniform } from '../../lib/volume';

const inputCls =
  'w-full rounded-lg border border-ink-200 bg-white px-2 py-1.5 sl-mono text-[16px] text-center text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]';

function PerSetRow({ log, isTimeBased, onUpdateSet, onRemoveSet, canRemove }) {
  const [reps, setReps] = useState(log.target_reps ?? '');
  const [seconds, setSeconds] = useState(log.target_duration_seconds ?? '');
  const [weight, setWeight] = useState(log.target_weight_kg ?? '');
  const [rest, setRest] = useState(log.target_rest_seconds ?? '');

  useEffect(() => {
    setReps(log.target_reps ?? '');
    setSeconds(log.target_duration_seconds ?? '');
    setWeight(log.target_weight_kg ?? '');
    setRest(log.target_rest_seconds ?? '');
  }, [log.id, log.target_reps, log.target_duration_seconds, log.target_weight_kg, log.target_rest_seconds]);

  function commitField(field, current, prev) {
    const v = current === '' ? null : Number(current);
    const prevNum = prev == null ? null : Number(prev);
    if (v !== prevNum) onUpdateSet(log.id, { [field]: v });
  }

  return (
    <tr>
      <td className="sl-mono text-[11px] text-ink-400 pr-2 text-center w-8">{log.set_number}</td>
      {isTimeBased ? (
        <td className="px-1">
          <input
            type="number"
            min={1}
            value={seconds}
            onChange={(e) => setSeconds(e.target.value)}
            onBlur={() => commitField('duration_seconds', seconds, log.target_duration_seconds)}
            aria-label={`Set ${log.set_number} seconds`}
            className={inputCls}
          />
        </td>
      ) : (
        <td className="px-1">
          <input
            type="number"
            min={1}
            value={reps}
            onChange={(e) => setReps(e.target.value)}
            onBlur={() => commitField('reps', reps, log.target_reps)}
            aria-label={`Set ${log.set_number} reps`}
            className={inputCls}
          />
        </td>
      )}
      <td className="px-1">
        <input
          type="number"
          min={0}
          step={0.5}
          value={weight}
          onChange={(e) => setWeight(e.target.value)}
          onBlur={() => commitField('weight_kg', weight, log.target_weight_kg)}
          placeholder="BW"
          aria-label={`Set ${log.set_number} weight`}
          className={inputCls}
        />
      </td>
      <td className="px-1">
        <input
          type="number"
          min={0}
          step={15}
          value={rest}
          onChange={(e) => setRest(e.target.value)}
          onBlur={() => commitField('rest_seconds', rest, log.target_rest_seconds)}
          placeholder="—"
          aria-label={`Set ${log.set_number} rest`}
          className={inputCls}
        />
      </td>
      <td className="pl-1 w-7">
        <button
          type="button"
          onClick={() => onRemoveSet(log.set_number)}
          disabled={!canRemove}
          aria-label={`Remove set ${log.set_number}`}
          className="w-7 h-7 rounded-md flex items-center justify-center text-ink-400 hover:bg-ink-100 hover:text-danger disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink-400 disabled:cursor-not-allowed"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </td>
    </tr>
  );
}

export default function ExerciseSlotRow({
  slot,
  onUpdate,
  onDelete,
  onUpdateSet,
  onResetToUniform,
  onAddSet,
  onRemoveSet,
  children,
}) {
  const ex = slot.exercise;
  const isTimeBased = slot.duration_seconds != null;
  const logs = useMemo(
    () => (slot.set_logs || []).slice().sort((a, b) => a.set_number - b.set_number),
    [slot.set_logs]
  );
  const uniform = isSlotUniform(slot);
  const [showCustom, setShowCustom] = useState(!uniform);

  // If the slot becomes non-uniform from outside (another tab edits it),
  // surface the per-set editor automatically. The reverse — uniform → compact
  // — is left to the explicit "Reset to uniform" action so the coach doesn't
  // get yanked back unexpectedly mid-edit.
  useEffect(() => {
    if (!uniform) setShowCustom(true);
  }, [uniform]);

  const headLog = logs[0] || null;
  const initialReps = headLog ? (headLog.target_reps ?? '') : (slot.reps ?? '');
  const initialSeconds = headLog
    ? (headLog.target_duration_seconds ?? '')
    : (slot.duration_seconds ?? '');
  const initialWeight = headLog ? (headLog.target_weight_kg ?? '') : (slot.weight_kg ?? '');
  const initialRest = headLog ? (headLog.target_rest_seconds ?? '') : (slot.rest_seconds ?? '');

  const [sets, setSets] = useState(slot.sets);
  const [reps, setReps] = useState(initialReps);
  const [seconds, setSeconds] = useState(initialSeconds);
  const [weight, setWeight] = useState(initialWeight);
  const [rest, setRest] = useState(initialRest);
  const [notes, setNotes] = useState(slot.notes ?? '');
  const [showNotes, setShowNotes] = useState(!!slot.notes);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const videoSets = Array.isArray(slot.record_video_set_numbers) ? slot.record_video_set_numbers : [];

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: slot.id });

  const sortableStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  useEffect(() => {
    setSets(slot.sets);
    setReps(headLog ? (headLog.target_reps ?? '') : (slot.reps ?? ''));
    setSeconds(headLog ? (headLog.target_duration_seconds ?? '') : (slot.duration_seconds ?? ''));
    setWeight(headLog ? (headLog.target_weight_kg ?? '') : (slot.weight_kg ?? ''));
    setRest(headLog ? (headLog.target_rest_seconds ?? '') : (slot.rest_seconds ?? ''));
    setNotes(slot.notes ?? '');
  }, [
    slot.id,
    slot.sets,
    slot.reps,
    slot.duration_seconds,
    slot.weight_kg,
    slot.rest_seconds,
    slot.notes,
    headLog?.id,
    headLog?.target_reps,
    headLog?.target_duration_seconds,
    headLog?.target_weight_kg,
    headLog?.target_rest_seconds,
  ]);

  function handleBlur() {
    const updates = {};
    if (sets !== slot.sets) updates.sets = sets;
    if (isTimeBased) {
      const s = seconds === '' ? null : Number(seconds);
      const prev = headLog ? headLog.target_duration_seconds : slot.duration_seconds;
      if (s !== (prev ?? null)) updates.duration_seconds = s;
    } else {
      const r = reps === '' ? null : Number(reps);
      const prev = headLog ? headLog.target_reps : slot.reps;
      if (r !== (prev ?? null)) updates.reps = r;
    }
    const w = weight === '' ? null : Number(weight);
    const prevW = headLog ? headLog.target_weight_kg : slot.weight_kg;
    const prevWNum = prevW == null ? null : Number(prevW);
    if (w !== prevWNum) updates.weight_kg = w;
    const rs = rest === '' ? null : Number(rest);
    const prevR = headLog ? headLog.target_rest_seconds : slot.rest_seconds;
    if (rs !== (prevR ?? null)) updates.rest_seconds = rs;
    if (Object.keys(updates).length > 0) onUpdate(updates);
  }

  function commitVideoSets(next) {
    const sorted = [...new Set(next)].filter((n) => n >= 1 && n <= Number(sets)).sort((a, b) => a - b);
    const current = [...videoSets].sort((a, b) => a - b);
    if (sorted.length === current.length && sorted.every((n, i) => n === current[i])) return;
    onUpdate({ record_video_set_numbers: sorted });
  }

  function toggleVideoSet(n) {
    const next = videoSets.includes(n) ? videoSets.filter((x) => x !== n) : [...videoSets, n];
    commitVideoSets(next);
  }

  function selectAllVideoSets() {
    commitVideoSets(Array.from({ length: Number(sets) || 0 }, (_, i) => i + 1));
  }

  function clearVideoSets() {
    commitVideoSets([]);
  }

  function handleNotesBlur() {
    const n = notes.trim() || null;
    if (n !== (slot.notes ?? null)) onUpdate({ notes: n });
  }

  function handleResetToUniform() {
    if (onResetToUniform) onResetToUniform();
    setShowCustom(false);
  }

  return (
    <div ref={setNodeRef} style={sortableStyle} className="sl-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <button
            type="button"
            {...attributes}
            {...listeners}
            aria-label={`Reorder ${ex.name}`}
            className="shrink-0 px-1 text-ink-400 hover:text-gray-700 cursor-grab active:cursor-grabbing touch-none"
          >
            <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">
              <circle cx="2.5" cy="3" r="1.25" />
              <circle cx="7.5" cy="3" r="1.25" />
              <circle cx="2.5" cy="8" r="1.25" />
              <circle cx="7.5" cy="8" r="1.25" />
              <circle cx="2.5" cy="13" r="1.25" />
              <circle cx="7.5" cy="13" r="1.25" />
            </svg>
          </button>
          <span className="sl-display text-[16px] text-gray-900 truncate">{ex.name}</span>
          <span className="sl-mono text-[10px] text-ink-400 shrink-0">D{ex.difficulty}</span>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={() => setConfirmDelete(true)}
            aria-label="Remove exercise"
            className="w-7 h-7 rounded-md flex items-center justify-center text-ink-400 hover:bg-ink-100 hover:text-danger"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>

          <ConfirmDialog
            open={confirmDelete}
            onClose={() => setConfirmDelete(false)}
            onConfirm={onDelete}
            title="Remove exercise"
            message={`Remove "${ex.name}" from this session? This can't be undone.`}
            confirmText="Remove"
          />
        </div>
      </div>

      {showCustom ? (
        <div className="space-y-2">
          <div className="flex justify-end">
            {uniform ? (
              <button
                type="button"
                onClick={() => setShowCustom(false)}
                className="sl-mono text-[11px] text-ink-400 hover:text-[var(--color-accent)] underline"
              >
                back to uniform
              </button>
            ) : (
              <button
                type="button"
                onClick={handleResetToUniform}
                className="sl-mono text-[11px] text-ink-400 hover:text-[var(--color-accent)] underline"
              >
                reset to uniform
              </button>
            )}
          </div>
          <table className="w-full" aria-label={`Per-set targets for ${ex.name}`}>
            <thead>
              <tr>
                <th className="sl-label text-ink-400 pr-2 text-center w-8">#</th>
                <th className="sl-label text-ink-400">{isTimeBased ? 'Sec' : 'Reps'}</th>
                <th className="sl-label text-ink-400">Weight</th>
                <th className="sl-label text-ink-400">Rest</th>
                <th className="w-7" aria-hidden="true" />
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <PerSetRow
                  key={log.id}
                  log={log}
                  isTimeBased={isTimeBased}
                  onUpdateSet={onUpdateSet}
                  onRemoveSet={(setNumber) => onRemoveSet?.(setNumber)}
                  canRemove={logs.length > 1}
                />
              ))}
            </tbody>
          </table>
          <button
            type="button"
            onClick={() => onAddSet?.()}
            className="w-full border border-dashed border-ink-200 text-ink-400 rounded-lg py-1.5 sl-mono text-[11px] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-colors"
          >
            + Add set
          </button>
        </div>
      ) : (
        <>
          <div className="flex gap-2">
            <div className="flex-1">
              <label htmlFor={`sets-${slot.id}`} className="sl-label text-ink-400 block mb-1">Sets</label>
              <input
                id={`sets-${slot.id}`}
                type="number"
                min={1}
                value={sets}
                onChange={(e) => setSets(Number(e.target.value))}
                onBlur={handleBlur}
                className={inputCls}
              />
            </div>
            {isTimeBased ? (
              <div className="flex-1">
                <label htmlFor={`seconds-${slot.id}`} className="sl-label text-ink-400 block mb-1">Seconds</label>
                <input
                  id={`seconds-${slot.id}`}
                  type="number"
                  min={1}
                  value={seconds}
                  onChange={(e) => setSeconds(e.target.value)}
                  onBlur={handleBlur}
                  className={inputCls}
                />
              </div>
            ) : (
              <div className="flex-1">
                <label htmlFor={`reps-${slot.id}`} className="sl-label text-ink-400 block mb-1">Reps</label>
                <input
                  id={`reps-${slot.id}`}
                  type="number"
                  min={1}
                  value={reps}
                  onChange={(e) => setReps(e.target.value)}
                  onBlur={handleBlur}
                  className={inputCls}
                />
              </div>
            )}
            <div className="flex-1">
              <label htmlFor={`weight-${slot.id}`} className="sl-label text-ink-400 block mb-1">Weight</label>
              <input
                id={`weight-${slot.id}`}
                type="number"
                min={0}
                step={0.5}
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
                onBlur={handleBlur}
                placeholder="BW"
                className={inputCls}
              />
            </div>
            <div className="flex-1">
              <label htmlFor={`rest-${slot.id}`} className="sl-label text-ink-400 block mb-1">Rest (s)</label>
              <input
                id={`rest-${slot.id}`}
                type="number"
                min={0}
                step={15}
                value={rest}
                onChange={(e) => setRest(e.target.value)}
                onBlur={handleBlur}
                placeholder="—"
                className={inputCls}
              />
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowCustom(true)}
            className="sl-mono text-[11px] text-ink-400 hover:text-[var(--color-accent)]"
          >
            + Customize sets
          </button>
        </>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <span className="sl-label text-ink-400">Record</span>
        <div className="flex gap-1 flex-wrap">
          {Array.from({ length: Number(sets) || 0 }, (_, i) => i + 1).map((n) => {
            const active = videoSets.includes(n);
            return (
              <button
                key={n}
                type="button"
                onClick={() => toggleVideoSet(n)}
                aria-pressed={active}
                className="sl-mono text-[11px] rounded-md w-7 h-6 flex items-center justify-center border transition-colors"
                style={
                  active
                    ? {
                        background: 'var(--color-warn)',
                        borderColor: 'var(--color-warn)',
                        color: 'var(--color-ink-900)',
                      }
                    : undefined
                }
              >
                <span className={active ? '' : 'text-ink-500'}>{n}</span>
              </button>
            );
          })}
        </div>
        {Number(sets) > 1 && (
          <button
            type="button"
            onClick={videoSets.length === Number(sets) ? clearVideoSets : selectAllVideoSets}
            className="sl-mono text-[11px] text-ink-400 hover:text-[var(--color-accent)] underline"
          >
            {videoSets.length === Number(sets) ? 'NONE' : 'ALL'}
          </button>
        )}
      </div>

      {showNotes ? (
        <div className="space-y-1">
          <label htmlFor={`notes-${slot.id}`} className="sl-label text-ink-400 block">
            Coach note for student
          </label>
          <textarea
            id={`notes-${slot.id}`}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={handleNotesBlur}
            placeholder="e.g. keep elbows tucked, focus on the negative…"
            rows={2}
            className="w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-[16px] text-gray-900 resize-none focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
          />
        </div>
      ) : (
        <button
          onClick={() => setShowNotes(true)}
          className="sl-mono text-[11px] text-ink-400 hover:text-[var(--color-accent)]"
        >
          + Add coach note
        </button>
      )}

      {children}
    </div>
  );
}
