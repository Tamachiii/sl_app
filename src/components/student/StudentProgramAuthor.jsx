import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Dialog from '../ui/Dialog';
import Spinner from '../ui/Spinner';
import UserMenu from '../ui/UserMenu';
import { useAuth } from '../../hooks/useAuth';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { useExerciseLibrary } from '../../hooks/useExerciseLibrary';
import {
  useMyDraft, useDraftTree, useCreateDraft,
  useAddDraftWeek, useAddDraftSession, useAddDraftSlot, useUpdateDraftSlot,
  useDeleteDraftRow, useSubmitDraft, useDeleteDraft,
} from '../../hooks/useAuthoring';

/**
 * Phase 3.4b — student program authoring. A student drafts a whole program
 * (weeks → sessions → exercise slots + slot-level targets) that stays inert
 * until the coach approves it. ONLINE-ONLY: every mutating control gates on
 * connectivity. English-only, matching the other student off-script surfaces.
 */
export default function StudentProgramAuthor() {
  const navigate = useNavigate();
  const { profile, signOut } = useAuth();
  const online = useOnlineStatus();
  const { data: draft, isLoading } = useMyDraft();

  return (
    <div className="p-4 pb-6 md:p-8 space-y-5">
      <div className="flex items-center justify-between gap-3 pt-3 pb-1">
        <div className="min-w-0">
          <div className="sl-label text-ink-400">Build</div>
          <h1 className="sl-display text-[22px] text-gray-900">Draft a program.</h1>
        </div>
        <UserMenu fullName={profile?.full_name} onSignOut={signOut} />
      </div>

      {!online && (
        <div
          className="rounded-lg px-3 py-2 sl-mono text-[12px] text-ink-600"
          style={{ background: 'color-mix(in srgb, var(--color-warn) 12%, transparent)' }}
        >
          You're offline — reconnect to build or edit a program.
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : draft ? (
        <DraftBuilder programId={draft.id} online={online} onDiscarded={() => navigate('/student')} />
      ) : (
        <CreateDraftCard online={online} />
      )}
    </div>
  );
}

function CreateDraftCard({ online }) {
  const [name, setName] = useState('');
  const create = useCreateDraft();
  return (
    <div className="sl-card p-4 space-y-3">
      <p className="text-[14px] text-gray-900">
        Sketch a program for your coach to review. They'll approve it (or send it back) before it goes live.
      </p>
      <label className="block">
        <span className="sl-label text-ink-400 block mb-1.5">Program name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. My off-season block"
          className="w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-[16px] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
        />
      </label>
      <button
        type="button"
        onClick={() => create.mutate({ name })}
        disabled={!online || create.isPending}
        className="sl-btn-primary w-full text-[13px] disabled:opacity-50"
        style={{ padding: '10px 16px' }}
      >
        {create.isPending ? 'Creating…' : 'Create draft'}
      </button>
    </div>
  );
}

function DraftBuilder({ programId, online, onDiscarded }) {
  const { data: tree, isLoading } = useDraftTree(programId);
  const { data: library } = useExerciseLibrary();
  const addWeek = useAddDraftWeek();
  const submit = useSubmitDraft();
  const discard = useDeleteDraft();
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const submitted = !!tree?.submitted_at;
  const canEdit = online && !submitted;
  const nextWeekNumber = useMemo(
    () => (tree?.weeks || []).reduce((m, w) => Math.max(m, w.week_number), 0) + 1,
    [tree],
  );

  if (isLoading) return <div className="flex justify-center py-12"><Spinner /></div>;
  if (!tree) return <p className="sl-mono text-[12px] text-ink-400">Draft not found.</p>;

  const totalSlots = (tree.weeks || []).reduce(
    (a, w) => a + (w.sessions || []).reduce((b, s) => b + (s.exercise_slots || []).length, 0), 0,
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="sl-display text-[18px] text-gray-900">{tree.name}</span>
        {submitted && (
          <span className="sl-pill" style={{ background: 'color-mix(in srgb, var(--color-accent) 15%, transparent)', color: 'var(--color-accent)' }}>
            Submitted — awaiting coach
          </span>
        )}
      </div>

      {submitted && (
        <p className="sl-mono text-[12px] text-ink-400">
          Your coach has been notified. You'll get a notification when they approve it or send it back.
        </p>
      )}

      {(tree.weeks || []).map((week) => (
        <WeekCard key={week.id} programId={programId} week={week} library={library || []} canEdit={canEdit} />
      ))}

      {canEdit && (
        <button
          type="button"
          onClick={() => addWeek.mutate({ programId, weekNumber: nextWeekNumber })}
          disabled={addWeek.isPending}
          className="sl-pill bg-ink-100 text-ink-600 hover:bg-ink-200 px-3 disabled:opacity-50"
        >
          + Add week
        </button>
      )}

      <div className="sl-card p-4 space-y-3">
        {!submitted && (
          <>
            <button
              type="button"
              onClick={() => submit.mutate({ programId })}
              disabled={!canEdit || submit.isPending || totalSlots === 0}
              title={totalSlots === 0 ? 'Add at least one exercise first' : undefined}
              className="sl-btn-primary w-full text-[13px] disabled:opacity-50"
              style={{ padding: '10px 16px' }}
            >
              {submit.isPending ? 'Submitting…' : 'Submit for approval'}
            </button>
            {totalSlots === 0 && (
              <p className="sl-mono text-[11px] text-ink-400 text-center">Add at least one exercise before submitting.</p>
            )}
          </>
        )}
        {confirmDiscard ? (
          <div className="rounded-lg p-3 space-y-2" style={{ background: 'color-mix(in srgb, var(--color-danger) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--color-danger) 35%, transparent)' }}>
            <p className="text-[13px] text-gray-900">Discard this draft? This can't be undone.</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => discard.mutate({ programId }, { onSuccess: onDiscarded })}
                disabled={discard.isPending}
                className="flex-1 rounded-lg py-2 sl-mono text-[12px] text-white disabled:opacity-50"
                style={{ background: 'var(--color-danger)' }}
              >
                DISCARD
              </button>
              <button type="button" onClick={() => setConfirmDiscard(false)} className="flex-1 sl-pill bg-ink-100 text-ink-700 hover:bg-ink-200 justify-center">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          online && (
            <button
              type="button"
              onClick={() => setConfirmDiscard(true)}
              className="sl-mono text-[11px] text-ink-400 hover:text-danger underline w-full"
            >
              Discard draft
            </button>
          )
        )}
      </div>
    </div>
  );
}

function WeekCard({ programId, week, library, canEdit }) {
  const addSession = useAddDraftSession();
  const del = useDeleteDraftRow();
  const nextSort = (week.sessions || []).reduce((m, s) => Math.max(m, s.sort_order), -1) + 1;
  return (
    <div className="sl-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="sl-display text-[15px] text-gray-900">Week {week.week_number}</span>
        {canEdit && (
          <button type="button" onClick={() => del.mutate({ table: 'weeks', id: week.id, programId })} className="sl-pill bg-ink-100 text-ink-500 hover:bg-ink-200 px-2.5">
            Remove week
          </button>
        )}
      </div>
      {(week.sessions || []).map((session) => (
        <SessionCard key={session.id} programId={programId} session={session} library={library} canEdit={canEdit} />
      ))}
      {canEdit && (
        <button
          type="button"
          onClick={() => addSession.mutate({ programId, weekId: week.id, title: `Day ${nextSort + 1}`, dayNumber: nextSort + 1, sortOrder: nextSort })}
          disabled={addSession.isPending}
          className="sl-pill bg-ink-100 text-ink-600 hover:bg-ink-200 px-3 disabled:opacity-50"
        >
          + Add session
        </button>
      )}
    </div>
  );
}

function SessionCard({ programId, session, library, canEdit }) {
  const addSlot = useAddDraftSlot();
  const del = useDeleteDraftRow();
  const [pickerOpen, setPickerOpen] = useState(false);
  const nextSort = (session.exercise_slots || []).reduce((m, s) => Math.max(m, s.sort_order), -1) + 1;
  return (
    <div className="rounded-lg border border-ink-100 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="sl-display text-[14px] text-gray-900">{session.title}</span>
        {canEdit && (
          <button type="button" onClick={() => del.mutate({ table: 'sessions', id: session.id, programId })} className="sl-mono text-[11px] text-ink-400 hover:text-danger">
            Remove
          </button>
        )}
      </div>
      <div className="space-y-1.5">
        {(session.exercise_slots || []).map((slot) => (
          <SlotRow key={slot.id} programId={programId} slot={slot} canEdit={canEdit} />
        ))}
      </div>
      {canEdit && (
        <>
          <button type="button" onClick={() => setPickerOpen(true)} className="sl-pill bg-ink-100 text-ink-600 hover:bg-ink-200 px-3">
            + Add exercise
          </button>
          <ExercisePicker
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            library={library}
            onPick={(exId) => {
              addSlot.mutate({ programId, sessionId: session.id, exerciseId: exId, sets: 3, reps: 5, sortOrder: nextSort });
              setPickerOpen(false);
            }}
          />
        </>
      )}
    </div>
  );
}

function SlotRow({ programId, slot, canEdit }) {
  const update = useUpdateDraftSlot();
  const del = useDeleteDraftRow();
  const [sets, setSets] = useState(String(slot.sets ?? 3));
  const [reps, setReps] = useState(String(slot.reps ?? 5));
  const [weight, setWeight] = useState(slot.weight_kg != null ? String(Number(slot.weight_kg)) : '');

  function commit() {
    update.mutate({
      programId, slotId: slot.id,
      sets: Math.max(1, parseInt(sets, 10) || 1),
      reps: reps.trim() === '' ? null : Math.max(1, parseInt(reps, 10) || 1),
      weightKg: weight.trim() === '' ? null : parseFloat(weight),
    });
  }

  return (
    <div className="rounded-lg bg-ink-50 px-3 py-2 flex items-center gap-2 flex-wrap">
      <span className="sl-display text-[14px] text-gray-900 flex-1 min-w-0 truncate">{slot.exercise?.name || 'Exercise'}</span>
      {canEdit ? (
        <>
          <NumberField label="sets" value={sets} onChange={setSets} onBlur={commit} width="w-12" />
          <NumberField label="reps" value={reps} onChange={setReps} onBlur={commit} width="w-12" />
          <NumberField label="kg" value={weight} onChange={setWeight} onBlur={commit} width="w-16" step="0.5" />
          <button type="button" onClick={() => del.mutate({ table: 'exercise_slots', id: slot.id, programId })} aria-label="Remove exercise" className="sl-pill bg-ink-100 text-ink-500 hover:bg-ink-200 px-2.5">
            ✕
          </button>
        </>
      ) : (
        <span className="sl-mono text-[12px] text-ink-500">
          {slot.sets} × {slot.reps ?? '—'}{slot.weight_kg != null ? ` @ ${Number(slot.weight_kg)}kg` : ''}
        </span>
      )}
    </div>
  );
}

function NumberField({ label, value, onChange, onBlur, width, step }) {
  return (
    <label className="flex items-center gap-1 text-[13px] text-ink-500">
      <input
        type="number"
        inputMode={step ? 'decimal' : 'numeric'}
        min="0"
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        aria-label={label}
        className={`${width} rounded-lg bg-white border border-ink-200 px-2 py-1.5 text-[16px] text-gray-900`}
      />
      <span className="sl-label normal-case">{label}</span>
    </label>
  );
}

function ExercisePicker({ open, onClose, library, onPick }) {
  const [query, setQuery] = useState('');
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (library || []).filter((e) => (q ? e.name.toLowerCase().includes(q) : true));
  }, [library, query]);
  return (
    <Dialog open={open} onClose={onClose} title="Add exercise">
      <p className="sl-mono text-[12px] text-ink-400 mb-3">Pick from your coach's library.</p>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search…"
        aria-label="Search exercises"
        className="w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-[16px] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] mb-3"
      />
      <div className="max-h-64 overflow-y-auto -mx-1 px-1 space-y-1">
        {candidates.length === 0 ? (
          <p className="sl-mono text-[12px] text-ink-400 py-4 text-center">No exercises found.</p>
        ) : (
          candidates.map((ex) => (
            <button key={ex.id} type="button" onClick={() => onPick(ex.id)} className="w-full flex items-center gap-2 rounded-lg px-3 py-2.5 text-left hover:bg-ink-50">
              <span className="sl-display text-[15px] text-gray-900 flex-1 min-w-0 truncate">{ex.name}</span>
              <span className={`sl-pill ${ex.type === 'pull' ? 'bg-pull/15 text-pull' : 'bg-push/15 text-push'}`}>{ex.type}</span>
            </button>
          ))
        )}
      </div>
    </Dialog>
  );
}
