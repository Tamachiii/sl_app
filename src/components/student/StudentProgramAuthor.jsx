import { useId, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Spinner from '../ui/Spinner';
import TypeBadge from '../ui/TypeBadge';
import UserMenu from '../ui/UserMenu';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../../hooks/useI18n';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { isActiveExercise, useExerciseLibrary } from '../../hooks/useExerciseLibrary';
import { useMyDraft, useDraftTree, useCreateDraft, useDraftActions } from '../../hooks/useAuthoring';
import { decimalText, parseDecimalInput } from '../../lib/number';
import { formatNumber } from '../../lib/i18n/format';
import { prescriptionText } from '../../lib/prescriptionText';
import { Button, ConfirmSheet, Icon, IconButton, LargeTitle, NumberField, SearchField, Sheet } from '../parc';

/**
 * Phase 3.4d — student program authoring, OFFLINE-CAPABLE. A student drafts a
 * whole program (weeks → sessions → exercise slots + slot-level targets) that
 * stays inert until the coach approves it. Every edit is an optimistic local
 * cache write that syncs as one idempotent whole-tree snapshot when online (or
 * on reconnect). In the Parc design (no mock): a section per phase, a card per
 * session, a row per exercise with its three fields; strings in `parcAuthor`.
 */
export default function StudentProgramAuthor() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { profile, signOut } = useAuth();
  const online = useOnlineStatus();
  const { data: draft, isLoading } = useMyDraft();

  return (
    <div className="flex flex-col gap-6 px-4 pt-3 pb-6 md:px-8">
      <LargeTitle
        title={t('parcAuthor.title')}
        trailing={<UserMenu fullName={profile?.full_name} onSignOut={signOut} profileHref="/student/profile" />}
      />

      {!online && <p className="m-0 rounded-group bg-amber-soft p-4 pk-body">{t('parcAuthor.offline')}</p>}

      {isLoading ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : draft ? (
        <DraftBuilder programId={draft.id} onDiscarded={() => navigate('/student')} />
      ) : (
        <CreateDraftCard />
      )}
    </div>
  );
}

function CreateDraftCard() {
  const { t } = useI18n();
  const nameId = useId();
  const [name, setName] = useState('');
  const create = useCreateDraft();
  return (
    <section className="flex flex-col gap-4 rounded-group bg-surface p-4">
      <p className="pk-body m-0">{t('parcAuthor.intro')}</p>
      <label htmlFor={nameId} className="flex flex-col gap-1.5">
        <span className="pk-caption">{t('parcAuthor.name')}</span>
        <input
          id={nameId}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('parcAuthor.namePlaceholder')}
          className="pk-field"
        />
      </label>
      <Button variant="primary" size="lg" onClick={() => create.mutate({ name })} disabled={create.isPending}>
        {create.isPending ? t('parcAuthor.creating') : t('parcAuthor.create')}
      </Button>
    </section>
  );
}

function DraftBuilder({ programId, onDiscarded }) {
  const { t } = useI18n();
  const { data: tree, isLoading } = useDraftTree(programId);
  const { data: library } = useExerciseLibrary();
  const actions = useDraftActions(programId);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const submitted = !!tree?.submitted_at;
  const canEdit = !submitted;

  const totalSlots = useMemo(
    () =>
      (tree?.weeks || []).reduce(
        (a, w) => a + (w.sessions || []).reduce((b, s) => b + (s.exercise_slots || []).length, 0), 0,
      ),
    [tree],
  );

  if (isLoading) return <div className="flex justify-center py-12"><Spinner /></div>;
  if (!tree) return <p className="pk-body m-0">{t('parcAuthor.notFound')}</p>;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="pk-title">{tree.name}</h2>
        {submitted && (
          <>
            <p className="m-0 mt-1 text-[15px] font-semibold text-blue">{t('parcAuthor.submitted')}</p>
            <p className="pk-caption m-0 mt-1">{t('parcAuthor.submittedBody')}</p>
          </>
        )}
      </div>

      {(tree.weeks || []).map((week) => (
        <WeekCard key={week.id} week={week} library={library || []} canEdit={canEdit} actions={actions} />
      ))}

      {canEdit && (
        <Button variant="text" className="self-start" onClick={actions.addWeek}>
          <Icon name="plus" size={18} />
          {t('parcProgram.addPhase')}
        </Button>
      )}

      <div className="flex flex-col gap-1">
        {!submitted && (
          <>
            <Button variant="primary" size="lg" onClick={actions.submit} disabled={totalSlots === 0}>
              {t('parcAuthor.submit')}
            </Button>
            {totalSlots === 0 && <p className="pk-caption m-0 text-center">{t('parcAuthor.submitEmpty')}</p>}
          </>
        )}
        <Button variant="text" className="text-red" onClick={() => setConfirmDiscard(true)}>
          {t('parcAuthor.discard')}
        </Button>
      </div>

      <ConfirmSheet
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        onConfirm={() => actions.discard({ onSettled: onDiscarded })}
        title={t('parcAuthor.discardTitle')}
        message={t('parcEditor.deleteMessage')}
        confirmText={t('parcAuthor.discard')}
      />
    </div>
  );
}

function WeekCard({ week, library, canEdit, actions }) {
  const { t, lang } = useI18n();
  const n = formatNumber(lang, week.week_number);
  return (
    <section aria-label={t('parcAuthor.phase', { n })} className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="pk-headline">{t('parcAuthor.phase', { n })}</h3>
        {canEdit && (
          <IconButton
            icon="close"
            tone="none"
            label={t('parcAuthor.removePhase', { n })}
            onClick={() => actions.deleteRow('weeks', week.id)}
          />
        )}
      </div>
      {(week.sessions || []).map((session) => (
        <SessionCard key={session.id} session={session} library={library} canEdit={canEdit} actions={actions} />
      ))}
      {canEdit && (
        <Button variant="text" className="self-start" onClick={() => actions.addSession(week.id)}>
          <Icon name="plus" size={18} />
          {t('parcProgram.addSession')}
        </Button>
      )}
    </section>
  );
}

function SessionCard({ session, library, canEdit, actions }) {
  const { t } = useI18n();
  const [pickerOpen, setPickerOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2 rounded-group bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <h4 className="pk-headline">{session.title}</h4>
        {canEdit && (
          <IconButton
            icon="close"
            tone="none"
            label={t('parcAuthor.remove', { name: session.title })}
            onClick={() => actions.deleteRow('sessions', session.id)}
          />
        )}
      </div>
      <ul className="flex flex-col">
        {(session.exercise_slots || []).map((slot) => (
          <SlotRow key={slot.id} slot={slot} canEdit={canEdit} actions={actions} />
        ))}
      </ul>
      {canEdit && (
        <>
          <Button variant="text" className="self-start" onClick={() => setPickerOpen(true)}>
            <Icon name="plus" size={18} />
            {t('parcEditor.addExercise')}
          </Button>
          <ExercisePicker
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            library={library}
            onPick={(exercise) => {
              actions.addSlot(session.id, exercise);
              setPickerOpen(false);
            }}
          />
        </>
      )}
    </div>
  );
}

// What the three fields of a slot take: the columns of `exercise_slots`.
// `sets` is NOT NULL and above 0; `reps` is above 0 and never null here — this
// UI never writes a duration, and a slot with neither aborts the whole-tree
// save at sync (XOR). `weight_kg` is a numeric(6,2), empty for bodyweight.
const SLOT_COUNT_RULES = { integer: true, min: 1, max: 2147483647, allowEmpty: false };
const SLOT_WEIGHT_RULES = { max: 9999.99 };

function SlotRow({ slot, canEdit, actions }) {
  const { t, lang } = useI18n();
  const alertId = useId();
  const [sets, setSets] = useState(decimalText(slot.sets ?? 3));
  const [reps, setReps] = useState(decimalText(slot.reps ?? 5));
  const [weight, setWeight] = useState(decimalText(slot.weight_kg));
  // A commit was refused; the fields still wrong are marked until they are not.
  const [refused, setRefused] = useState(false);

  // Read as typed: "62,5" and "62.5" are 62.5 kg in every browser (P31). A
  // number field gave "" in WebKit — saved as null, bodyweight — and 625 in an
  // English Chromium, and garbage in sets or reps was quietly made 1.
  const setsInput = parseDecimalInput(sets, SLOT_COUNT_RULES);
  const repsInput = parseDecimalInput(reps, SLOT_COUNT_RULES);
  const weightInput = parseDecimalInput(weight, SLOT_WEIGHT_RULES);

  // On the blur of any field. Nothing is written while one of them says
  // something the slot cannot hold: the draft keeps the slot as it was.
  function commit() {
    if (!setsInput.ok || !repsInput.ok || !weightInput.ok) {
      setRefused(true);
      return;
    }
    setRefused(false);
    actions.updateSlot(slot.id, {
      sets: setsInput.value,
      reps: repsInput.value,
      weight_kg: weightInput.value,
    });
  }

  // One message, for the first field on the line that is wrong; the fields it
  // is about point at it.
  const countWrong = refused && (!setsInput.ok || !repsInput.ok);
  const weightWrong = refused && !countWrong && !weightInput.ok;
  const message = countWrong
    ? t('sessionDecimalInput.wholeNumberAtLeastOne')
    : weightWrong
      ? t('uiSharedHelpers.decimalInvalid')
      : null;
  const describe = (wrong) => (wrong ? alertId : undefined);

  const name = slot.exercise?.name || t('parcAuthor.exerciseFallback');
  const ctx = { t, lang };
  return (
    <li className="flex flex-col gap-2 border-t border-line py-3 first:border-t-0">
      <div className="flex items-center gap-2">
        <span className="pk-body min-w-0 flex-1 truncate font-semibold">{name}</span>
        {canEdit && (
          <IconButton
            icon="close"
            tone="none"
            size={18}
            label={t('parcAuthor.remove', { name })}
            onClick={() => actions.deleteRow('exercise_slots', slot.id)}
          />
        )}
      </div>
      {canEdit ? (
        <>
          <div className="grid grid-cols-3 gap-2">
            <NumberField
              {...SLOT_COUNT_RULES}
              label={t('parcEditor.sets')}
              value={sets}
              onChange={(e) => setSets(e.target.value)}
              onBlur={commit}
              invalid={refused && !setsInput.ok}
              aria-describedby={describe(countWrong && !setsInput.ok)}
            />
            <NumberField
              {...SLOT_COUNT_RULES}
              label={t('parcEditor.reps')}
              value={reps}
              onChange={(e) => setReps(e.target.value)}
              onBlur={commit}
              invalid={refused && !repsInput.ok}
              aria-describedby={describe(countWrong && !repsInput.ok)}
            />
            <NumberField
              {...SLOT_WEIGHT_RULES}
              label={t('parcEditor.load')}
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
              onBlur={commit}
              invalid={refused && !weightInput.ok}
              aria-describedby={describe(weightWrong)}
            />
          </div>
          {message && (
            <p id={alertId} role="alert" className="m-0 text-[13px] leading-[1.35] text-red">
              {message}
            </p>
          )}
        </>
      ) : (
        <span className="pk-caption">{prescriptionText(slot, ctx)}</span>
      )}
    </li>
  );
}

function ExercisePicker({ open, onClose, library, onPick }) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  // An exercise the coach archived stays in the library read — the slots that
  // already use it need its name — but is not offered for a new slot.
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (library || [])
      .filter(isActiveExercise)
      .filter((e) => (q ? e.name.toLowerCase().includes(q) : true));
  }, [library, query]);
  return (
    <Sheet open={open} onClose={onClose} title={t('parcEditor.addExercise')} description={t('parcAuthor.pickerHint')}>
      <div className="flex flex-col gap-3">
        <SearchField label={t('parcLibrary.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="max-h-72 overflow-y-auto">
          {candidates.length === 0 ? (
            <p className="pk-caption m-0 py-4 text-center">{t('parcAuthor.noExercise')}</p>
          ) : (
            <ul className="pk-group">
              {candidates.map((ex) => (
                <li key={ex.id}>
                  <button type="button" onClick={() => onPick(ex)} className="pk-row w-full bg-transparent text-left">
                    <span className="pk-headline min-w-0 flex-1 truncate">{ex.name}</span>
                    <TypeBadge type={ex.type} className="shrink-0" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Sheet>
  );
}
