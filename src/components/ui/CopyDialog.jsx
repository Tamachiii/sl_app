import { useState } from 'react';
import Dialog from './Dialog';
import { useStudents } from '../../hooks/useStudents';
import { useActiveProgram, useProgram } from '../../hooks/useProgram';

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
 *   dropdown and picking them targets THIS program's weeks (not their active
 *   one, which may be a different block). Without it the current athlete is
 *   excluded, preserving the old copy-to-another-student-only behaviour.
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
  const { data: students } = useStudents();
  const [copyStudentId, setCopyStudentId] = useState('');
  const [copyWeekId, setCopyWeekId] = useState('');
  const isSameStudent = !!currentProgramId && copyStudentId === currentStudentId;
  // Cross-student copy targets the destination student's ACTIVE block; a
  // same-athlete copy targets the exact program open in the editor.
  const { data: activeProgram } = useActiveProgram(
    copyStudentId && !isSameStudent ? copyStudentId : undefined,
  );
  const { data: sameProgram } = useProgram(isSameStudent ? currentProgramId : undefined);
  const destProgram = isSameStudent ? sameProgram : activeProgram;
  const destWeeks = destProgram?.weeks || [];

  function handleClose() {
    setCopyStudentId('');
    setCopyWeekId('');
    onClose();
  }

  function handleCopy() {
    if (showWeekSelect && !copyWeekId) return;
    if (!showWeekSelect && !destProgram?.id) return;
    onCopy({
      studentId: copyStudentId,
      programId: destProgram?.id,
      weekId: copyWeekId || undefined,
    });
    setCopyStudentId('');
    setCopyWeekId('');
  }

  const copyDisabled = showWeekSelect
    ? !copyWeekId || isPending
    : !destProgram?.id || isPending;

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
          <span className="sl-label text-ink-400 block mb-1.5">Student</span>
          <select
            value={copyStudentId}
            onChange={(e) => {
              setCopyStudentId(e.target.value);
              setCopyWeekId('');
            }}
            className={selectCls}
          >
            <option value="">Select student…</option>
            {(students || [])
              .filter((s) => currentProgramId || s.id !== currentStudentId)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.profile?.full_name || 'Unnamed student'}
                  {s.id === currentStudentId ? ' (this athlete)' : ''}
                </option>
              ))}
          </select>
        </label>

        {showWeekSelect && (
          <label className="block">
            <span className="sl-label text-ink-400 block mb-1.5">Destination week</span>
            <select
              value={copyWeekId}
              onChange={(e) => setCopyWeekId(e.target.value)}
              disabled={!copyStudentId || destWeeks.length === 0}
              className={selectCls}
            >
              <option value="">
                {!copyStudentId
                  ? 'Select a student first'
                  : destWeeks.length === 0
                    ? 'No weeks in this student\u2019s program'
                    : 'Select week…'}
              </option>
              {destWeeks.map((w) => (
                <option key={w.id} value={w.id}>
                  Week {w.week_number}
                  {w.label ? ` — ${w.label}` : ''}
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
            {isPending ? 'Copying…' : 'Copy'}
          </button>
          <button
            onClick={handleClose}
            className="flex-1 bg-ink-100 text-ink-700 rounded-lg py-2 sl-display text-[13px] hover:bg-ink-200"
          >
            Cancel
          </button>
        </div>
      </div>
    </Dialog>
  );
}
