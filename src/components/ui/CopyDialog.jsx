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
 */
export default function CopyDialog({
  open,
  onClose,
  title,
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
  const { data: destProgram } = useProgram(copyProgramId || undefined);
  const destWeeks = destProgram?.weeks || [];

  function handleClose() {
    setCopyStudentId('');
    setCopyProgramId('');
    setCopyWeekId('');
    onClose();
  }

  function handleCopy() {
    if (showWeekSelect && !copyWeekId) return;
    if (!copyProgramId) return;
    onCopy({
      studentId: copyStudentId,
      programId: copyProgramId,
      weekId: copyWeekId || undefined,
    });
    setCopyStudentId('');
    setCopyProgramId('');
    setCopyWeekId('');
  }

  const copyDisabled = showWeekSelect
    ? !copyWeekId || isPending
    : !copyProgramId || isPending;

  // Inputs use bg-white + border-ink-200 (both have dark-mode remaps in index.css)
  // so the select adapts to either theme. `disabled:bg-gray-50` — which we used
  // before — has no dark-mode variant generated, so the disabled dropdown
  // rendered white on dark. Use `disabled:bg-ink-100` instead (full dark remap).
  const selectCls =
    'w-full rounded-lg border border-ink-200 bg-white px-3 py-2 sl-mono text-[16px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] disabled:bg-ink-100 disabled:text-ink-400 disabled:cursor-not-allowed';

  return (
    <Dialog open={open} onClose={handleClose} title={title}>
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
            value={copyProgramId}
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
              value={copyWeekId}
              onChange={(e) => setCopyWeekId(e.target.value)}
              disabled={!copyProgramId || destWeeks.length === 0}
              className={selectCls}
            >
              <option value="">
                {!copyProgramId
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
            onClick={handleClose}
            className="flex-1 bg-ink-100 text-ink-700 rounded-lg py-2 sl-display text-[13px] hover:bg-ink-200"
          >
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
