import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import ConfirmDialog from '../ui/ConfirmDialog';
import DecimalInput from '../ui/DecimalInput';
import { isSlotUniform } from '../../lib/volume';
import { isLoggedSet } from '../../lib/loggedSets';
import { decimalText, parseDecimalInput } from '../../lib/number';
import { useI18n } from '../../hooks/useI18n';

// `disabled:opacity-*`, not a `disabled:bg-*`: the dark theme is a class remap
// and a disabled background variant does not pick it up (see INVARIANTS).
const inputCls =
  'w-full rounded-lg border border-ink-200 bg-white px-2 py-1.5 sl-mono text-[16px] text-center text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] disabled:opacity-60 disabled:cursor-not-allowed';

// A target weight is read with `parseDecimalInput` under these rules: "62,5"
// and "62.5" are 62.5 whatever the language of the browser. A number field
// read "62,5" as 625 in an English Chromium, and as "" in WebKit — which was
// written as null, shown to the athlete as "BW". The range is what
// `exercise_slots.weight_kg` and `set_logs.target_weight_kg` hold, a
// numeric(6,2). An empty field is still an answer: no load, bodyweight.
// Text that is not a number of the range writes nothing, and the field shows
// the stored value again — set here, since the resync effects only run when
// the props change.
const TARGET_WEIGHT_RULES = { max: 9999.99 };

// `logged`: the athlete has trained this set — its targets are what they were
// asked to do when they did it, so the row shows them and edits nothing.
// `locked` also covers a whole session opened read-only.
function PerSetRow({ log, isTimeBased, onUpdateSet, onRemoveSet, canRemove, logged, locked }) {
  const { t } = useI18n();
  const [reps, setReps] = useState(log.target_reps ?? '');
  const [seconds, setSeconds] = useState(log.target_duration_seconds ?? '');
  const [weight, setWeight] = useState(decimalText(log.target_weight_kg));
  const [rest, setRest] = useState(log.target_rest_seconds ?? '');
  const rowRef = useRef(null);

  useEffect(() => {
    // See the matching guard in ExerciseSlotRow: never overwrite fields the
    // coach is typing in right now.
    if (rowRef.current?.contains(document.activeElement)) return;
    setReps(log.target_reps ?? '');
    setSeconds(log.target_duration_seconds ?? '');
    setWeight(decimalText(log.target_weight_kg));
    setRest(log.target_rest_seconds ?? '');
  }, [log.id, log.target_reps, log.target_duration_seconds, log.target_weight_kg, log.target_rest_seconds]);

  function commitField(field, current, prev) {
    const v = current === '' ? null : Number(current);
    const prevNum = prev == null ? null : Number(prev);
    if (v !== prevNum) onUpdateSet(log.id, { [field]: v });
  }

  // See TARGET_WEIGHT_RULES: never a write for text the field cannot read.
  function commitWeight() {
    const parsed = parseDecimalInput(weight, TARGET_WEIGHT_RULES);
    if (!parsed.ok) {
      setWeight(decimalText(log.target_weight_kg));
      return;
    }
    const prev = log.target_weight_kg == null ? null : Number(log.target_weight_kg);
    if (parsed.value !== prev) onUpdateSet(log.id, { weight_kg: parsed.value });
  }

  return (
    <tr ref={rowRef}>
      <td className="sl-mono text-[11px] text-ink-400 pr-2 text-center w-8">{log.set_number}</td>
      {isTimeBased ? (
        <td className="px-1">
          <input
            type="number"
            min={1}
            value={seconds}
            onChange={(e) => setSeconds(e.target.value)}
            onBlur={() => commitField('duration_seconds', seconds, log.target_duration_seconds)}
            aria-label={t('coach.slot.setSecondsAria', { n: log.set_number })}
            disabled={locked}
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
            aria-label={t('coach.slot.setRepsAria', { n: log.set_number })}
            disabled={locked}
            className={inputCls}
          />
        </td>
      )}
      <td className="px-1">
        <DecimalInput
          {...TARGET_WEIGHT_RULES}
          value={weight}
          onChange={(e) => setWeight(e.target.value)}
          onBlur={commitWeight}
          placeholder={t('coach.slot.bwPlaceholder')}
          aria-label={t('coach.slot.setWeightAria', { n: log.set_number })}
          disabled={locked}
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
          placeholder={t('coach.slot.restPlaceholder')}
          aria-label={t('coach.slot.setRestAria', { n: log.set_number })}
          disabled={locked}
          className={inputCls}
        />
      </td>
      <td className="pl-1 w-7">
        {logged ? (
          // Where the remove button would be: the reason there is none.
          <span
            role="img"
            aria-label={t('coachLoggedHistory.slot.setLogged', { n: log.set_number })}
            title={t('coachLoggedHistory.slot.setLogged', { n: log.set_number })}
            className="w-7 h-7 flex items-center justify-center"
            style={{ color: 'var(--color-success)' }}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
            </svg>
          </span>
        ) : !locked && (
          <button
            type="button"
            onClick={() => onRemoveSet(log.set_number)}
            disabled={!canRemove}
            aria-label={t('coach.slot.removeSetAria', { n: log.set_number })}
            className="w-7 h-7 rounded-md flex items-center justify-center text-ink-400 hover:bg-ink-100 hover:text-danger disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink-400 disabled:cursor-not-allowed"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
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
  readOnly = false,
  children,
}) {
  const { t } = useI18n();
  const ex = slot.exercise;
  const isTimeBased = slot.duration_seconds != null;
  const logs = useMemo(
    () =>
      (slot.set_logs || [])
        // Student-added extras are logging artifacts, not prescription: keep
        // them out of the editor so the coach can't edit or remove a
        // student's logged set from here, and the uniform check reflects
        // only prescribed rows.
        .filter((l) => !l.is_student_added)
        .sort((a, b) => a.set_number - b.set_number),
    [slot.set_logs]
  );
  const uniform = isSlotUniform(slot);
  const [showCustom, setShowCustom] = useState(!uniform);

  // Two locks, and they are not the same thing.
  //
  // A PRESCRIBED set the athlete has logged is read-only in every case, which
  // also takes away the compact "one row for all sets" view: its fields would
  // have to say what happens to the logged sets when they change, and the
  // answer is "nothing". The per-set table shows it instead — logged rows
  // locked, pending rows still editable, so the rest of an exercise the
  // athlete is half-way through can still be re-planned.
  //
  // The exercise itself cannot be removed while ANY of its rows is logged,
  // student-added extras included: the delete would cascade to them.
  const hasLoggedSets = logs.some(isLoggedSet);
  const holdsTraining = hasLoggedSets || (slot.set_logs || []).some(isLoggedSet);
  const perSet = showCustom || hasLoggedSets;

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
  const initialWeight = decimalText(headLog ? headLog.target_weight_kg : slot.weight_kg);
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

  // dnd-kit owns the node via a callback ref; keep our own handle on the same
  // element so the resync effect below can ask whether focus is inside it.
  const rootRef = useRef(null);
  const setRefs = useCallback(
    (node) => {
      rootRef.current = node;
      setNodeRef(node);
    },
    [setNodeRef],
  );

  const sortableStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  // Pull fresh server values into the local draft — but never while the coach
  // is typing inside this card. Committing one field on blur refetches the
  // whole slot, and without this guard that response lands mid-keystroke in
  // the NEXT field and replaces what has been typed so far with the stored
  // value. Non-focused fields already equal what was committed, so skipping
  // the sync while focus is inside the card loses nothing.
  useEffect(() => {
    if (rootRef.current?.contains(document.activeElement)) return;
    setSets(slot.sets);
    setReps(headLog ? (headLog.target_reps ?? '') : (slot.reps ?? ''));
    setSeconds(headLog ? (headLog.target_duration_seconds ?? '') : (slot.duration_seconds ?? ''));
    setWeight(decimalText(headLog ? headLog.target_weight_kg : slot.weight_kg));
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
    // Sets is CHECK-constrained > 0 in the DB. Committing an invalid value
    // (cleared field, 0, NaN, a stray negative) would either fail server-side
    // with zero feedback or — worse — destructively shrink the slot. One
    // uniform rule: any entry below 1 reverts to the current value.
    const parsed = Math.floor(Number(sets));
    const nextSets = Number.isFinite(parsed) && parsed >= 1 ? parsed : slot.sets;
    if (nextSets !== sets) setSets(nextSets);
    if (nextSets !== slot.sets) updates.sets = nextSets;
    if (isTimeBased) {
      const s = seconds === '' ? null : Number(seconds);
      const prev = headLog ? headLog.target_duration_seconds : slot.duration_seconds;
      if (s !== (prev ?? null)) updates.duration_seconds = s;
    } else {
      const r = reps === '' ? null : Number(reps);
      const prev = headLog ? headLog.target_reps : slot.reps;
      if (r !== (prev ?? null)) updates.reps = r;
    }
    // A weight the field cannot read is left out of this write (see
    // TARGET_WEIGHT_RULES); the other fields of the blur still go.
    const w = parseDecimalInput(weight, TARGET_WEIGHT_RULES);
    const prevW = headLog ? headLog.target_weight_kg : slot.weight_kg;
    const prevWNum = prevW == null ? null : Number(prevW);
    if (!w.ok) setWeight(decimalText(prevW));
    else if (w.value !== prevWNum) updates.weight_kg = w.value;
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
    <div ref={setRefs} style={sortableStyle} className="sl-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {!readOnly && (
            <button
              type="button"
              {...attributes}
              {...listeners}
              aria-label={t('coach.slot.reorderAria', { name: ex.name })}
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
          )}
          <span className="sl-display text-[16px] text-gray-900 truncate">{ex.name}</span>
          <span className="sl-mono text-[10px] text-ink-400 shrink-0">
            {t('coach.slot.difficultyShort', { n: ex.difficulty })}
          </span>
        </div>
        {!readOnly && (
          <div className="flex items-center gap-0.5 shrink-0">
            {/* Disabled rather than hidden while the exercise holds logged
                sets: a button that vanished would read as a bug, and the
                title says why it is off. */}
            <button
              onClick={() => setConfirmDelete(true)}
              disabled={holdsTraining}
              aria-label={t('coach.slot.removeExerciseAria')}
              title={holdsTraining ? t('coachLoggedHistory.slot.removeBlocked') : undefined}
              className="w-7 h-7 rounded-md flex items-center justify-center text-ink-400 hover:bg-ink-100 hover:text-danger disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink-400 disabled:cursor-not-allowed"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>

            <ConfirmDialog
              open={confirmDelete}
              onClose={() => setConfirmDelete(false)}
              onConfirm={onDelete}
              title={t('coach.slot.removeExerciseTitle')}
              message={t('coach.slot.removeExerciseMessage', { name: ex.name })}
              confirmText={t('coach.slot.remove')}
            />
          </div>
        )}
      </div>

      {perSet ? (
        <div className="space-y-2">
          {/* No way back to the compact view once a set is logged (see
              `perSet` above), and nothing to reset in a read-only session. */}
          {!readOnly && !hasLoggedSets && (
            <div className="flex justify-end">
              {uniform ? (
                <button
                  type="button"
                  onClick={() => setShowCustom(false)}
                  className="sl-mono text-[11px] text-ink-400 hover:text-[var(--color-accent)] underline"
                >
                  {t('coach.slot.backToUniform')}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleResetToUniform}
                  className="sl-mono text-[11px] text-ink-400 hover:text-[var(--color-accent)] underline"
                >
                  {t('coach.slot.resetToUniform')}
                </button>
              )}
            </div>
          )}
          <table className="w-full" aria-label={t('coach.slot.perSetTargetsAria', { name: ex.name })}>
            <thead>
              <tr>
                <th className="sl-label text-ink-400 pr-2 text-center w-8">{t('coach.slot.colSet')}</th>
                <th className="sl-label text-ink-400">
                  {isTimeBased ? t('coach.slot.colSec') : t('coach.slot.colReps')}
                </th>
                <th className="sl-label text-ink-400">{t('coach.slot.colWeight')}</th>
                <th className="sl-label text-ink-400">{t('coach.slot.colRest')}</th>
                <th className="w-7" aria-hidden="true" />
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => {
                const logged = isLoggedSet(log);
                return (
                  <PerSetRow
                    key={log.id}
                    log={log}
                    isTimeBased={isTimeBased}
                    onUpdateSet={onUpdateSet}
                    onRemoveSet={(setNumber) => onRemoveSet?.(setNumber)}
                    canRemove={logs.length > 1}
                    logged={logged}
                    locked={readOnly || logged}
                  />
                );
              })}
            </tbody>
          </table>
          {!readOnly && (
            <button
              type="button"
              onClick={() => onAddSet?.()}
              className="w-full border border-dashed border-ink-200 text-ink-400 rounded-lg py-1.5 sl-mono text-[11px] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-colors"
            >
              {t('coach.slot.addSet')}
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="flex gap-2">
            <div className="flex-1">
              <label htmlFor={`sets-${slot.id}`} className="sl-label text-ink-400 block mb-1">{t('coach.slot.sets')}</label>
              <input
                id={`sets-${slot.id}`}
                type="number"
                min={1}
                value={sets}
                onChange={(e) => setSets(e.target.value === '' ? '' : Number(e.target.value))}
                onBlur={handleBlur}
                disabled={readOnly}
                className={inputCls}
              />
            </div>
            {isTimeBased ? (
              <div className="flex-1">
                <label htmlFor={`seconds-${slot.id}`} className="sl-label text-ink-400 block mb-1">{t('coach.slot.seconds')}</label>
                <input
                  id={`seconds-${slot.id}`}
                  type="number"
                  min={1}
                  value={seconds}
                  onChange={(e) => setSeconds(e.target.value)}
                  onBlur={handleBlur}
                  disabled={readOnly}
                  className={inputCls}
                />
              </div>
            ) : (
              <div className="flex-1">
                <label htmlFor={`reps-${slot.id}`} className="sl-label text-ink-400 block mb-1">{t('coach.slot.reps')}</label>
                <input
                  id={`reps-${slot.id}`}
                  type="number"
                  min={1}
                  value={reps}
                  onChange={(e) => setReps(e.target.value)}
                  onBlur={handleBlur}
                  disabled={readOnly}
                  className={inputCls}
                />
              </div>
            )}
            <div className="flex-1">
              <label htmlFor={`weight-${slot.id}`} className="sl-label text-ink-400 block mb-1">{t('coach.slot.weight')}</label>
              <DecimalInput
                id={`weight-${slot.id}`}
                {...TARGET_WEIGHT_RULES}
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
                onBlur={handleBlur}
                placeholder={t('coach.slot.bwPlaceholder')}
                disabled={readOnly}
                className={inputCls}
              />
            </div>
            <div className="flex-1">
              <label htmlFor={`rest-${slot.id}`} className="sl-label text-ink-400 block mb-1">{t('coach.slot.restSeconds')}</label>
              <input
                id={`rest-${slot.id}`}
                type="number"
                min={0}
                step={15}
                value={rest}
                onChange={(e) => setRest(e.target.value)}
                onBlur={handleBlur}
                placeholder={t('coach.slot.restPlaceholder')}
                disabled={readOnly}
                className={inputCls}
              />
            </div>
          </div>
          {!readOnly && (
            <button
              type="button"
              onClick={() => setShowCustom(true)}
              className="sl-mono text-[11px] text-ink-400 hover:text-[var(--color-accent)]"
            >
              {t('coach.slot.customizeSets')}
            </button>
          )}
        </>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <span className="sl-label text-ink-400">{t('coach.slot.record')}</span>
        <div className="flex gap-1 flex-wrap">
          {Array.from({ length: Number(sets) || 0 }, (_, i) => i + 1).map((n) => {
            const active = videoSets.includes(n);
            return (
              <button
                key={n}
                type="button"
                onClick={() => toggleVideoSet(n)}
                aria-pressed={active}
                disabled={readOnly}
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
        {Number(sets) > 1 && !readOnly && (
          <button
            type="button"
            onClick={videoSets.length === Number(sets) ? clearVideoSets : selectAllVideoSets}
            className="sl-mono text-[11px] text-ink-400 hover:text-[var(--color-accent)] underline"
          >
            {videoSets.length === Number(sets)
              ? t('coach.slot.recordNone')
              : t('coach.slot.recordAll')}
          </button>
        )}
      </div>

      {showNotes ? (
        <div className="space-y-1">
          <label htmlFor={`notes-${slot.id}`} className="sl-label text-ink-400 block">
            {t('coach.slot.noteLabel')}
          </label>
          <textarea
            id={`notes-${slot.id}`}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={handleNotesBlur}
            placeholder={t('coach.slot.notePlaceholder')}
            rows={2}
            // readOnly, not disabled: a note is prose the coach may still want
            // to read in full and copy.
            readOnly={readOnly}
            className="w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-[16px] text-gray-900 resize-none focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
          />
        </div>
      ) : !readOnly && (
        <button
          onClick={() => setShowNotes(true)}
          className="sl-mono text-[11px] text-ink-400 hover:text-[var(--color-accent)]"
        >
          {t('coach.slot.addNote')}
        </button>
      )}

      {children}
    </div>
  );
}
