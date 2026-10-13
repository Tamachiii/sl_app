import { useState } from 'react';
import Dialog from './Dialog';
import { useStudents } from '../../hooks/useStudents';
import { useProgramsForStudent, useProgram } from '../../hooks/useProgram';
import { useI18n } from '../../hooks/useI18n';

/**
 * Shared dialog for copying a week or session to another student's program —
 * or, when `currentProgramId` is supplied, to another week of the SAME
 * athlete's program the coach is currently editing.
 *
 * Props:
 * - open / onClose: dialog visibility
 * - title: dialog heading
 * - description: optional helper text
 * - currentStudentId: the athlete being edited
 * - currentProgramId: optional. When set, the current athlete stays in the
 *   dropdown so a coach can copy within the same athlete. Without it the
 *   current athlete is excluded.
 *
 * The destination is picked in full — athlete, then BLOCK, then week. It used
 * to jump straight to the destination athlete's ACTIVE program, which dead-
 * ended with "No weeks" for an athlete who had none and made it impossible to
 * prepare a block in advance.
 * - showWeekSelect: if true, shows a "destination week" dropdown (for session copy)
 * - onCopy({ studentId, programId, weekId? }): called when the user clicks Copy
 * - isPending: disables the copy button and shows "Copying…"
 *
 * The destination is kept for as long as the dialog is open, and forgotten
 * when it closes — whoever closes it: Cancel, the cross, Escape, or the parent
 * once the copy is made. `Dialog` mounts its children only while it is open,
 * so the three selects live in `CopyForm` and go with it. Copy does NOT clear
 * them: the parent closes the dialog when the copy succeeds, and a copy that
 * is refused leaves it open with the destination still chosen, to be sent
 * again.
 */
export default function CopyDialog({ open, onClose, title, ...form }) {
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <CopyForm onClose={onClose} {...form} />
    </Dialog>
  );
}

function CopyForm({
  onClose,
  description,
  currentStudentId,
  currentProgramId,
  showWeekSelect = false,
  onCopy,
  isPending = false,
}) {
  const { t } = useI18n();
  const { data: students } = useStudents();
  const [copyStudentId, setCopyStudentId] = useState('');
  const [copyProgramId, setCopyProgramId] = useState('');
  const [copyWeekId, setCopyWeekId] = useState('');

  // Every block the destination athlete has, not just the active one.
  const { data: destPrograms } = useProgramsForStudent(copyStudentId || undefined);
  // A choice counts for as long as it is offered. The block can go to the
  // trash, and the phase be deleted, while the dialog is open — that is what
  // a refused copy is followed by, once the lists are read again — and the
  // select then shows its placeholder: Copy must not send what is not shown.
  const programId = (destPrograms || []).some((p) => p.id === copyProgramId) ? copyProgramId : '';
  const { data: destProgram } = useProgram(programId || undefined);
  const destWeeks = destProgram?.weeks || [];
  const weekId = programId && destWeeks.some((w) => w.id === copyWeekId) ? copyWeekId : '';

  function handleCopy() {
    if (showWeekSelect && !weekId) return;
    if (!programId) return;
    onCopy({
      studentId: copyStudentId,
      programId,
      weekId: weekId || undefined,
    });
  }

  const copyDisabled = showWeekSelect
    ? !weekId || isPending
    : !programId || isPending;

  // Inputs use bg-white + border-ink-200 (both have dark-mode remaps in index.css)
  // so the select adapts to either theme. `disabled:bg-gray-50` — which we used
  // before — has no dark-mode variant generated, so the disabled dropdown
  // rendered white on dark. Use `disabled:bg-ink-100` instead (full dark remap).
  const selectCls =
    'w-full rounded-lg border border-ink-200 bg-white px-3 py-2 sl-mono text-[16px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] disabled:bg-ink-100 disabled:text-ink-400 disabled:cursor-not-allowed';

  return (
    <div className="space-y-3">
      {description && (
        <p className="sl-mono text-[11px] text-ink-400">{description}</p>
      )}
      <label className="block">
        <span className="sl-label text-ink-400 block mb-1.5">{t('coach.copy.student')}</span>
        <select
          value={copyStudentId}
          onChange={(e) => {
            setCopyStudentId(e.target.value);
            setCopyProgramId('');
            setCopyWeekId('');
          }}
          className={selectCls}
        >
          <option value="">{t('coach.copy.selectStudent')}</option>
          {(students || [])
            .filter((s) => currentProgramId || s.id !== currentStudentId)
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.profile?.full_name || t('coach.copy.unnamedStudent')}
                {s.id === currentStudentId ? t('coach.copy.thisAthleteSuffix') : ''}
              </option>
            ))}
        </select>
      </label>

      <label className="block">
        <span className="sl-label text-ink-400 block mb-1.5">{t('coach.copy.destinationBlock')}</span>
        <select
          value={programId}
          onChange={(e) => {
            setCopyProgramId(e.target.value);
            setCopyWeekId('');
          }}
          disabled={!copyStudentId || (destPrograms || []).length === 0}
          className={selectCls}
        >
          <option value="">
            {!copyStudentId
              ? t('coach.copy.selectStudentFirst')
              : (destPrograms || []).length === 0
                ? t('coach.copy.noBlocks')
                : t('coach.copy.selectBlock')}
          </option>
          {(destPrograms || []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.is_active ? t('coach.copy.activeSuffix') : ''}
            </option>
          ))}
        </select>
      </label>

      {showWeekSelect && (
        <label className="block">
          <span className="sl-label text-ink-400 block mb-1.5">{t('coach.copy.destinationWeek')}</span>
          <select
            value={weekId}
            onChange={(e) => setCopyWeekId(e.target.value)}
            disabled={!programId || destWeeks.length === 0}
            className={selectCls}
          >
            <option value="">
              {!programId
                ? t('coach.copy.selectBlockFirst')
                : destWeeks.length === 0
                  ? t('coach.copy.noWeeks')
                  : t('coach.copy.selectWeek')}
            </option>
            {destWeeks.map((w) => (
              <option key={w.id} value={w.id}>
                {t('coach.copy.weekOption', { n: w.week_number })}
                {w.label ? t('coach.copy.weekLabelSuffix', { label: w.label }) : ''}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="flex gap-2 pt-1">
        <button
          onClick={handleCopy}
          disabled={copyDisabled}
          className="flex-1 sl-btn-primary text-[13px] disabled:opacity-50"
          style={{ padding: '10px 16px' }}
        >
          {isPending ? t('coach.copy.copying') : t('coach.copy.copy')}
        </button>
        <button
          onClick={onClose}
          className="flex-1 bg-ink-100 text-ink-700 rounded-lg py-2 sl-display text-[13px] hover:bg-ink-200"
        >
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}
