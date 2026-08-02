import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  sortableKeyboardCoordinates,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  useCreateWeek,
  useReorderWeeks,
  useUpdateWeek,
  useDeleteWeek,
  useCreateSession,
  useUpdateSession,
} from '../../hooks/useWeek';
import { useDuplicateWeek } from '../../hooks/useDuplicate';
import { useProgramConfirmedSessionIds } from '../../hooks/useSessionConfirmation';
import { useI18n } from '../../hooks/useI18n';
import { DAY_FULL, DAY_LABELS, compareSessions, nextFreeDayNumber } from '../../lib/day';
import EditableText from '../ui/EditableText';
import CopyDialog from '../ui/CopyDialog';
import ConfirmDialog from '../ui/ConfirmDialog';
import EmptyState from '../ui/EmptyState';

/**
 * The week the coach most likely wants open: the first with an unconfirmed,
 * non-archived session, falling back to the last week. Mirrors the definition
 * `useCoachDashboardPrograms` uses for the roster's "active week" so the two
 * surfaces agree on where the athlete currently is.
 */
function currentWeekId(weeks, confirmedIds) {
  const list = weeks || [];
  for (const w of list) {
    const pending = (w.sessions || []).some(
      (s) => !s.archived_at && !confirmedIds?.has(s.id),
    );
    if (pending) return w.id;
  }
  return list[list.length - 1]?.id ?? null;
}

function activeSessions(week) {
  return (week.sessions || []).filter((s) => !s.archived_at).sort(compareSessions);
}

// Which week the coach had open, per program. Survives stepping into a session
// editor and back, which is the whole point — the sheet is where the coach
// works, and re-collapsing it every time loses their place.
const OPEN_WEEK_KEY = 'sl_coach_open_week';

function readOpenWeek(programId) {
  try {
    return JSON.parse(localStorage.getItem(OPEN_WEEK_KEY) || '{}')[programId] ?? null;
  } catch {
    return null;
  }
}

function writeOpenWeek(programId, weekId) {
  try {
    const all = JSON.parse(localStorage.getItem(OPEN_WEEK_KEY) || '{}');
    localStorage.setItem(OPEN_WEEK_KEY, JSON.stringify({ ...all, [programId]: weekId }));
  } catch {
    /* private mode / quota — the sheet still works, it just won't remember */
  }
}

function DayPill({ session, onPick, t }) {
  const [open, setOpen] = useState(false);
  const dn = session.day_number;
  const label = dn >= 1 && dn <= 7 ? DAY_LABELS[dn - 1] : '—';
  const full = dn >= 1 && dn <= 7 ? DAY_FULL[dn - 1] : '—';

  return (
    <span className="relative shrink-0">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-label={t('coach.sheet.setDay', { day: full })}
        aria-expanded={open}
        className="sl-mono text-[10px] font-semibold px-1.5 py-1 rounded bg-ink-100 text-ink-700 hover:bg-ink-200 transition-colors w-10 text-center"
      >
        {full.toUpperCase()}
      </button>
      {open && (
        <>
          {/* Click-away layer; sits under the menu but over the rows. */}
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            onClick={(e) => { e.stopPropagation(); setOpen(false); }}
            className="fixed inset-0 z-10 cursor-default"
          />
          <span className="absolute left-0 top-full mt-1 z-20 flex gap-0.5 p-1 rounded-lg sl-card">
            {DAY_LABELS.map((d, i) => (
              <button
                key={i}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onPick(i + 1);
                  setOpen(false);
                }}
                aria-label={DAY_FULL[i]}
                aria-current={dn === i + 1}
                className={`w-6 h-6 rounded sl-mono text-[10px] font-semibold transition-colors ${
                  dn === i + 1
                    ? 'bg-accent text-ink-900'
                    : 'bg-ink-100 text-ink-700 hover:bg-ink-200'
                }`}
              >
                {d}
              </button>
            ))}
          </span>
        </>
      )}
    </span>
  );
}

// No delete control here on purpose: a destructive icon on every row of the
// main authoring surface is both visual noise and a mis-tap waiting to happen
// on a phone. Deleting a session lives in the session editor, where the coach
// has already committed to that one session.
function SessionRow({ session, studentId, confirmed, onSetDay, t }) {
  const navigate = useNavigate();
  const exCount = (session.exercise_slots || []).length;

  return (
    <div className="flex items-center gap-2 px-3 py-2 border-t border-ink-100">
      <DayPill session={session} onPick={onSetDay} t={t} />
      <button
        type="button"
        onClick={() => navigate(`/coach/students/${studentId}/s/${session.id}`)}
        aria-label={t('coach.week.openSession')}
        className="flex-1 min-w-0 text-left flex items-baseline gap-2 group"
      >
        <span className="sl-display text-[14px] text-gray-900 truncate group-hover:text-[var(--color-accent)] transition-colors">
          {session.title || t('coach.week.sessionN', { n: session.day_number })}
        </span>
        <span className="sl-mono text-[10px] text-ink-400 shrink-0">
          {t('coach.week.exCount', { n: exCount })}
        </span>
      </button>
      {confirmed && (
        <span
          aria-label={t('coach.week.confirmedByStudent')}
          title={t('coach.week.confirmedByStudent')}
          className="w-4 h-4 rounded-full flex items-center justify-center shrink-0"
          style={{ background: 'var(--color-success)', color: 'var(--color-ink-900)' }}
        >
          <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
          </svg>
        </span>
      )}
    </div>
  );
}

// Reorder lives here rather than as a standing top-level button: it is a rare,
// mode-entering action, and the ⋯ already exists so it costs no extra chrome.
// It has to stay a mode (not always-on drag handles) because on touch a drag
// handle competes with vertical scroll.
function WeekMenu({ onDuplicate, onCopy, onDelete, onReorder, canReorder, t }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative shrink-0">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        aria-label={t('coach.sheet.weekMenu')}
        aria-expanded={open}
        className="w-7 h-7 rounded-lg text-ink-400 hover:bg-ink-100 hover:text-ink-700 flex items-center justify-center transition-colors"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
          <circle cx="3" cy="7" r="1.4" /><circle cx="7" cy="7" r="1.4" /><circle cx="11" cy="7" r="1.4" />
        </svg>
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            onClick={(e) => { e.stopPropagation(); setOpen(false); }}
            className="fixed inset-0 z-10 cursor-default"
          />
          <span className="absolute right-0 top-full mt-1 z-20 sl-card p-1 flex flex-col min-w-[150px]">
            {[
              { label: t('coach.week.duplicate'), fn: onDuplicate, danger: false },
              { label: t('coach.week.copyTo'), fn: onCopy, danger: false },
              ...(canReorder
                ? [{ label: t('coach.sheet.reorderWeeks'), fn: onReorder, danger: false }]
                : []),
              { label: t('coach.week.delete'), fn: onDelete, danger: true },
            ].map(({ label, fn, danger }) => (
              <button
                key={label}
                type="button"
                onClick={(e) => { e.stopPropagation(); setOpen(false); fn(); }}
                className={`text-left px-2.5 py-1.5 rounded sl-mono text-[11px] hover:bg-ink-100 transition-colors ${
                  danger ? 'text-danger' : 'text-ink-700'
                }`}
              >
                {label}
              </button>
            ))}
          </span>
        </>
      )}
    </span>
  );
}

function WeekCard({
  week, studentId, expanded, onToggle, confirmedIds, reordering, canReorder, onReorder, t,
}) {
  const updateWeek = useUpdateWeek();
  const updateSession = useUpdateSession();
  const createSession = useCreateSession();
  const deleteWeek = useDeleteWeek();
  const duplicateWeek = useDuplicateWeek();
  const [showCopy, setShowCopy] = useState(false);
  const [confirmDeleteWeek, setConfirmDeleteWeek] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const navigate = useNavigate();
  const archived = (week.sessions || []).filter((s) => s.archived_at).sort(compareSessions);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: week.id, disabled: !reordering });

  const sessions = activeSessions(week);
  const exTotal = sessions.reduce((n, s) => n + (s.exercise_slots || []).length, 0);

  function handleAddSession() {
    const all = week.sessions || [];
    // max(sort_order)+1 across ALL sessions, archived included —
    // UNIQUE(week_id, sort_order) rejects a value an archived row still holds.
    const nextSortOrder = all.length > 0
      ? Math.max(...all.map((s) => s.sort_order ?? 0)) + 1
      : 0;
    createSession.mutate({
      weekId: week.id,
      title: t('coach.week.sessionN', { n: sessions.length + 1 }),
      dayNumber: nextFreeDayNumber(sessions),
      sortOrder: nextSortOrder,
    });
  }

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className="sl-card overflow-hidden"
    >
      <div
        className="flex items-center gap-2 px-3 py-2.5"
        style={expanded ? { borderLeft: '3px solid var(--color-accent)' } : undefined}
      >
        {reordering && (
          <button
            {...attributes}
            {...listeners}
            aria-label={t('coach.week.reorderWeek', { n: week.week_number })}
            className="text-ink-400 hover:text-ink-700 cursor-grab active:cursor-grabbing touch-none shrink-0 p-1"
          >
            <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">
              <circle cx="2.5" cy="3" r="1.25" /><circle cx="7.5" cy="3" r="1.25" />
              <circle cx="2.5" cy="8" r="1.25" /><circle cx="7.5" cy="8" r="1.25" />
              <circle cx="2.5" cy="13" r="1.25" /><circle cx="7.5" cy="13" r="1.25" />
            </svg>
          </button>
        )}

        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={t('coach.week.weekLabel', { n: week.week_number })}
          className="sl-mono text-[11px] font-semibold text-gray-900 shrink-0"
        >
          {t('coach.week.weekShort', { n: week.week_number })}
        </button>

        {/* Sibling of the toggle, not nested inside it — an editable field
            inside a button is not operable. Tap the number/meta to expand,
            tap the label to rename.

            Only the OPEN week offers the editable field: an unlabelled week
            renders EditableText's "Label" placeholder, and a stack of those
            down a 12-week block reads as noise rather than affordance. */}
        <div className="flex-1 min-w-0">
          {expanded ? (
            <EditableText
              value={week.label || ''}
              onSave={(label) => updateWeek.mutate({ id: week.id, label })}
              placeholder={t('coach.week.labelPlaceholder')}
              ariaLabel={t('coach.week.editLabelAria')}
              className="sl-display text-[13px] text-ink-700"
            />
          ) : (
            <button
              type="button"
              onClick={onToggle}
              aria-label={t('coach.week.weekLabel', { n: week.week_number })}
              className="w-full text-left sl-display text-[13px] text-ink-700 truncate"
            >
              {week.label || ''}
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={t('coach.week.weekLabel', { n: week.week_number })}
          className="flex items-center gap-1.5 shrink-0"
        >
          <span className="sl-mono text-[10px] text-ink-400">
            {t('coach.sheet.weekMeta', { s: sessions.length, e: exTotal })}
          </span>
          <svg
            className={`w-3.5 h-3.5 text-ink-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
            fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>

        {!reordering && (
          <WeekMenu
            t={t}
            canReorder={canReorder}
            onReorder={onReorder}
            onDuplicate={() => duplicateWeek.mutate({ weekId: week.id })}
            onCopy={() => setShowCopy(true)}
            onDelete={() => setConfirmDeleteWeek(true)}
          />
        )}
      </div>

      {expanded && !reordering && (
        <>
          {sessions.length === 0 && (
            <p className="sl-mono text-[11px] text-ink-400 px-3 py-3 border-t border-ink-100">
              {t('coach.week.noSessions')}
            </p>
          )}

          {sessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              studentId={studentId}
              confirmed={confirmedIds?.has(s.id)}
              onSetDay={(day) => updateSession.mutate({ id: s.id, day_number: day })}
              t={t}
            />
          ))}

          {archived.length > 0 && (
            <div className="border-t border-ink-100">
              <button
                type="button"
                onClick={() => setShowArchived((v) => !v)}
                className="w-full text-ink-400 py-2 sl-mono text-[10px] hover:text-ink-700 underline"
              >
                {showArchived
                  ? t('coach.week.hideArchived', { n: archived.length })
                  : t('coach.week.showArchived', { n: archived.length })}
              </button>
              {showArchived && archived.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => navigate(`/coach/student/${studentId}/session/${s.id}/review`)}
                  aria-label={t('coach.week.openArchivedSession')}
                  className="w-full flex items-center gap-2 px-3 py-2 border-t border-ink-100 opacity-75 hover:opacity-100 text-left"
                >
                  <span className="sl-display text-[13px] text-ink-600 flex-1 truncate">
                    {s.title || t('coach.week.sessionN', { n: s.day_number })}
                  </span>
                  <span
                    className="sl-pill text-ink-900 shrink-0"
                    style={{ background: 'color-mix(in srgb, var(--color-warn) 18%, transparent)' }}
                  >
                    {t('common.archived')}
                  </span>
                </button>
              ))}
            </div>
          )}

          <button
            type="button"
            onClick={handleAddSession}
            disabled={createSession.isPending}
            className="w-full border-t border-ink-100 text-ink-400 py-2.5 sl-mono text-[11px] hover:text-[var(--color-accent)] transition-colors"
          >
            {t('coach.week.addSession')}
          </button>
        </>
      )}

      <CopyDialog
        open={showCopy}
        onClose={() => setShowCopy(false)}
        title={t('coach.week.copyTitle')}
        description={t('coach.week.copyDescription')}
        currentStudentId={studentId}
        currentProgramId={week.program_id}
        onCopy={({ programId }) => {
          if (!programId) return;
          duplicateWeek.mutate({ weekId: week.id, programId }, { onSuccess: () => setShowCopy(false) });
        }}
        isPending={duplicateWeek.isPending}
      />

      <ConfirmDialog
        open={confirmDeleteWeek}
        onClose={() => setConfirmDeleteWeek(false)}
        title={t('coach.week.deleteWeekTitle')}
        message={t('coach.week.deleteWeekMessage', { n: week.week_number })}
        onConfirm={() => deleteWeek.mutate(week.id)}
      />
    </div>
  );
}

/**
 * The Programming tab's body: the whole training block on one page. Each week
 * lists its own sessions inline, so the coach reads the shape of the block
 * without navigating and is one tap from any session's exercises.
 *
 * Replaces the old WeekTimeline chip strip + WeekView page pair, which showed
 * nothing at this level and cost two navigations to reach an exercise.
 */
export default function ProgramSheet({ studentId, program }) {
  const { t } = useI18n();
  const createWeek = useCreateWeek();
  const reorderWeeks = useReorderWeeks();
  const { data: confirmedIds } = useProgramConfirmedSessionIds(program.id);

  const weeks = useMemo(() => program.weeks || [], [program.weeks]);
  // Seeded from the remembered choice so returning from a session editor lands
  // on the same week. `null` = never chosen → fall back to the active week.
  const [openWeekId, setOpenWeekId] = useState(() => readOpenWeek(program.id));
  const [reordering, setReordering] = useState(false);

  // Uncontrolled until the coach picks a week: default to where the athlete
  // currently is, recomputed as confirmations land.
  const defaultOpen = useMemo(
    () => currentWeekId(weeks, confirmedIds),
    [weeks, confirmedIds],
  );
  // A remembered week that no longer exists (deleted, or a different program
  // selected) must not leave every week collapsed.
  const remembered = openWeekId && weeks.some((w) => w.id === openWeekId) ? openWeekId : null;
  const expandedId = remembered ?? (openWeekId === '' ? '' : defaultOpen);

  function handleToggleWeek(weekId) {
    const next = weekId === expandedId ? '' : weekId;
    setOpenWeekId(next);
    writeOpenWeek(program.id, next);
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleAddWeek() {
    const nextNum = weeks.length > 0
      ? Math.max(...weeks.map((w) => w.week_number)) + 1
      : 1;
    createWeek.mutate({ programId: program.id, weekNumber: nextNum });
  }

  function handleDragEnd({ active, over }) {
    if (!over || active.id === over.id) return;
    const oldIdx = weeks.findIndex((w) => w.id === active.id);
    const newIdx = weeks.findIndex((w) => w.id === over.id);
    if (oldIdx === -1 || newIdx === -1) return;
    reorderWeeks.mutate({
      programId: program.id,
      orderedIds: arrayMove(weeks, oldIdx, newIdx).map((w) => w.id),
    });
  }

  return (
    <div className="space-y-2">
      {/* Only visible WHILE reordering — entering the mode is a rare action and
          lives in each week's ⋯ menu, so it no longer occupies a standing
          top-level button above every block. */}
      {reordering && (
        <div className="flex items-center justify-between gap-2">
          <span className="sl-mono text-[11px] text-ink-400">
            {t('coach.sheet.reorderHint')}
          </span>
          <button
            type="button"
            onClick={() => setReordering(false)}
            className="sl-pill shrink-0"
            style={{ background: 'var(--color-accent)', color: 'var(--color-ink-900)' }}
          >
            {t('common.done')}
          </button>
        </div>
      )}

      {weeks.length === 0 && <EmptyState message={t('coach.sheet.noWeeks')} />}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={weeks.map((w) => w.id)} strategy={verticalListSortingStrategy}>
          <div className="space-y-2">
            {weeks.map((w) => (
              <WeekCard
                key={w.id}
                week={w}
                studentId={studentId}
                expanded={!reordering && w.id === expandedId}
                onToggle={() => handleToggleWeek(w.id)}
                canReorder={weeks.length > 1}
                onReorder={() => setReordering(true)}
                confirmedIds={confirmedIds}
                reordering={reordering}
                t={t}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      <button
        type="button"
        onClick={handleAddWeek}
        disabled={createWeek.isPending}
        className="w-full border border-dashed border-ink-200 text-ink-400 rounded-xl py-3 sl-mono text-[11px] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-colors"
      >
        {t('coach.week.addWeek')}
      </button>
    </div>
  );
}
