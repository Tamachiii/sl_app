import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import DecimalInput from '../ui/DecimalInput';
import { isSlotUniform } from '../../lib/volume';
import { isLoggedSet } from '../../lib/loggedSets';
import { decimalText, parseDecimalInput } from '../../lib/number';
import { formatNumber } from '../../lib/i18n/format';
import { prescriptionText } from '../../lib/prescriptionText';
import { useI18n } from '../../hooks/useI18n';
import { Button, ConfirmSheet, Icon, IconButton } from '../parc';

// The fields of a target (design/parc/screens/Editeur.dc.html): a `pk-field`
// in condensed digits, centred. A locked field reads as text on `fill`.
const inputCls =
  'pk-field pk-condensed pk-tnum min-w-0 px-1 text-center text-[20px] disabled:border-transparent disabled:bg-fill disabled:text-ink';

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
  const { t, lang } = useI18n();
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
      <td className="pk-condensed pk-tnum w-8 pr-1 text-center text-[20px] font-extrabold">
        {formatNumber(lang, log.set_number)}
      </td>
      {isTimeBased ? (
        <td className="px-1 py-1">
          <input
            type="number"
            min={1}
            value={seconds}
            onChange={(e) => setSeconds(e.target.value)}
            onBlur={() => commitField('duration_seconds', seconds, log.target_duration_seconds)}
            aria-label={t('parcEditor.setSeconds', { n: log.set_number })}
            disabled={locked}
            className={inputCls}
          />
        </td>
      ) : (
        <td className="px-1 py-1">
          <input
            type="number"
            min={1}
            value={reps}
            onChange={(e) => setReps(e.target.value)}
            onBlur={() => commitField('reps', reps, log.target_reps)}
            aria-label={t('parcEditor.setReps', { n: log.set_number })}
            disabled={locked}
            className={inputCls}
          />
        </td>
      )}
      <td className="px-1 py-1">
        <DecimalInput
          {...TARGET_WEIGHT_RULES}
          value={weight}
          onChange={(e) => setWeight(e.target.value)}
          onBlur={commitWeight}
          placeholder={t('parcEditor.bodyweight')}
          aria-label={t('parcEditor.setLoad', { n: log.set_number })}
          disabled={locked}
          className={inputCls}
        />
      </td>
      <td className="px-1 py-1">
        <input
          type="number"
          min={0}
          step={15}
          value={rest}
          onChange={(e) => setRest(e.target.value)}
          onBlur={() => commitField('rest_seconds', rest, log.target_rest_seconds)}
          placeholder="–"
          aria-label={t('parcEditor.setRest', { n: log.set_number })}
          disabled={locked}
          className={inputCls}
        />
      </td>
      <td className="w-11 pl-1">
        {logged ? (
          // Where the remove button would be: the reason there is none.
          <span
            role="img"
            aria-label={t('coachLoggedHistory.slot.setLogged', { n: log.set_number })}
            title={t('coachLoggedHistory.slot.setLogged', { n: log.set_number })}
            className="flex h-11 w-11 items-center justify-center text-blue"
          >
            <Icon name="check" size={18} />
          </span>
        ) : !locked && (
          <IconButton
            icon="close"
            tone="none"
            size={18}
            onClick={() => onRemoveSet(log.set_number)}
            disabled={!canRemove}
            label={t('parcEditor.removeSet', { n: log.set_number })}
            className="disabled:opacity-40"
          />
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
  const ctx = useI18n();
  const { t, lang } = ctx;
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

  const labelCls = 'pk-small text-center';
  const summary = prescriptionText({ ...slot, set_logs: logs }, ctx);

  return (
    <section
      ref={setRefs}
      style={sortableStyle}
      aria-label={ex.name}
      className="flex flex-col gap-3 rounded-group bg-surface p-4"
    >
      <div className="flex items-start gap-1">
        <div className="min-w-0 flex-1 py-1">
          <h2 className="pk-headline">{ex.name}</h2>
          <p className="pk-caption">
            {[summary, t('parcEditor.level', { n: formatNumber(lang, ex.difficulty) })].filter(Boolean).join(', ')}
          </p>
        </div>
        {!readOnly && (
          <>
            <button
              type="button"
              {...attributes}
              {...listeners}
              aria-label={t('parcProgram.moveItem', { name: ex.name })}
              className="pk-icon-btn shrink-0 cursor-grab touch-none bg-transparent active:cursor-grabbing"
            >
              <Icon name="drag" size={22} />
            </button>
            {/* Disabled rather than hidden while the exercise holds logged
                sets: a button that vanished would read as a bug, and the
                title says why it is off. */}
            <IconButton
              icon="close"
              tone="none"
              onClick={() => setConfirmDelete(true)}
              disabled={holdsTraining}
              label={t('parcEditor.removeExercise', { name: ex.name })}
              title={holdsTraining ? t('coachLoggedHistory.slot.removeBlocked') : undefined}
              className="disabled:opacity-40"
            />
            <ConfirmSheet
              open={confirmDelete}
              onClose={() => setConfirmDelete(false)}
              onConfirm={onDelete}
              title={t('parcEditor.removeTitle', { name: ex.name })}
              message={t('parcEditor.removeMessage')}
              confirmText={t('parcEditor.removeAction')}
            />
          </>
        )}
      </div>

      {perSet ? (
        <div className="flex flex-col gap-2">
          <table className="w-full" aria-label={t('parcEditor.perSetLabel', { name: ex.name })}>
            <thead>
              <tr>
                <th className={`${labelCls} w-8 pr-1 font-normal`}>{t('parcEditor.colSet')}</th>
                <th className={`${labelCls} font-normal`}>
                  {isTimeBased ? t('parcEditor.seconds') : t('parcEditor.reps')}
                </th>
                <th className={`${labelCls} font-normal`}>{t('parcEditor.load')}</th>
                <th className={`${labelCls} font-normal`}>{t('parcEditor.rest')}</th>
                <th className="w-11" aria-hidden="true" />
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
            <div className="flex flex-wrap items-center gap-x-2">
              <Button variant="text" onClick={() => onAddSet?.()}>
                <Icon name="plus" size={18} />
                {t('parcEditor.addSet')}
              </Button>
              {/* No way back to the compact view once a set is logged (see
                  `perSet` above). */}
              {!hasLoggedSets &&
                (uniform ? (
                  <Button variant="text" onClick={() => setShowCustom(false)}>
                    {t('parcEditor.backToUniform')}
                  </Button>
                ) : (
                  <Button variant="text" onClick={handleResetToUniform}>
                    {t('parcEditor.resetToUniform')}
                  </Button>
                ))}
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-2">
            <div className="flex flex-col gap-1">
              <label htmlFor={`sets-${slot.id}`} className={labelCls}>{t('parcEditor.sets')}</label>
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
              <div className="flex flex-col gap-1">
                <label htmlFor={`seconds-${slot.id}`} className={labelCls}>{t('parcEditor.seconds')}</label>
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
              <div className="flex flex-col gap-1">
                <label htmlFor={`reps-${slot.id}`} className={labelCls}>{t('parcEditor.reps')}</label>
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
            <div className="flex flex-col gap-1">
              <label htmlFor={`weight-${slot.id}`} className={labelCls}>{t('parcEditor.load')}</label>
              <DecimalInput
                id={`weight-${slot.id}`}
                {...TARGET_WEIGHT_RULES}
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
                onBlur={handleBlur}
                placeholder={t('parcEditor.bodyweight')}
                disabled={readOnly}
                className={inputCls}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor={`rest-${slot.id}`} className={labelCls}>{t('parcEditor.rest')}</label>
              <input
                id={`rest-${slot.id}`}
                type="number"
                min={0}
                step={15}
                value={rest}
                onChange={(e) => setRest(e.target.value)}
                onBlur={handleBlur}
                placeholder="–"
                disabled={readOnly}
                className={inputCls}
              />
            </div>
          </div>
          {!readOnly && (
            <Button variant="text" className="self-start" onClick={() => setShowCustom(true)}>
              {t('parcEditor.perSet')}
            </Button>
          )}
        </>
      )}

      <div className="flex flex-col gap-1.5">
        <span className="pk-caption">{t('parcEditor.record')}</span>
        <div className="flex flex-wrap items-center gap-1.5">
          {Array.from({ length: Number(sets) || 0 }, (_, i) => i + 1).map((n) => {
            const active = videoSets.includes(n);
            return (
              <button
                key={n}
                type="button"
                onClick={() => toggleVideoSet(n)}
                aria-pressed={active}
                aria-label={t('parcEditor.recordSet', { n })}
                disabled={readOnly}
                className={`pk-tnum h-11 w-11 rounded-control text-[16px] font-semibold ${
                  active ? 'bg-ink text-surface' : 'bg-fill text-ink'
                } disabled:opacity-60`}
              >
                {formatNumber(lang, n)}
              </button>
            );
          })}
          {Number(sets) > 1 && !readOnly && (
            <Button
              variant="text"
              onClick={videoSets.length === Number(sets) ? clearVideoSets : selectAllVideoSets}
              aria-label={t(videoSets.length === Number(sets) ? 'parcEditor.recordNoneLabel' : 'parcEditor.recordAllLabel', {
                name: ex.name,
              })}
            >
              {videoSets.length === Number(sets) ? t('parcEditor.recordNone') : t('parcEditor.recordAll')}
            </Button>
          )}
        </div>
      </div>

      {showNotes ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`notes-${slot.id}`} className="pk-caption">
            {t('parcEditor.note')}
          </label>
          <textarea
            id={`notes-${slot.id}`}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={handleNotesBlur}
            placeholder={t('parcEditor.notePlaceholder')}
            rows={2}
            // readOnly, not disabled: a note is prose the coach may still want
            // to read in full and copy.
            readOnly={readOnly}
            className="pk-field resize-none py-2.5 leading-[1.45]"
          />
        </div>
      ) : !readOnly && (
        <Button variant="text" className="self-start" onClick={() => setShowNotes(true)}>
          {t('parcEditor.addNote')}
        </Button>
      )}

      {children}
    </section>
  );
}
