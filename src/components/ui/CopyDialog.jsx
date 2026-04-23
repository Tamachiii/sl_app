import { useState } from 'react';
import Dialog from './Dialog';
import { useStudents } from '../../hooks/useStudents';
import { useActiveProgram } from '../../hooks/useProgram';

/**
 * Shared dialog for copying a week or session to another student's program.
 *
 * Props:
 * - open / onClose: dialog visibility
 * - title: dialog heading
 * - description: optional helper text
 * - currentStudentId: the student to exclude from the dropdown
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
  showWeekSelect = false,
  onCopy,
  isPending = false,
}) {
  const { data: students } = useStudents();
  const [copyStudentId, setCopyStudentId] = useState('');
  const [copyWeekId, setCopyWeekId] = useState('');
  // Copy targets the destination student's currently-active program block.
  const { data: destProgram } = useActiveProgram(copyStudentId || undefined);
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

  return (
    <Dialog open={open} onClose={handleClose} title={title}>
      <div className="space-y-3">
        {description && (
          <p className="text-xs text-gray-500">{description}</p>
        )}
        <label className="block">
          <span className="text-xs text-gray-600 block mb-1">Student</span>
          <select
            value={copyStudentId}
            onChange={(e) => {
              setCopyStudentId(e.target.value);
              setCopyWeekId('');
            }}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="">Select student…</option>
            {(students || [])
              .filter((s) => s.id !== currentStudentId)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.profile?.full_name || 'Unnamed student'}
                </option>
              ))}
          </select>
        </label>

        {showWeekSelect && (
          <label className="block">
            <span className="text-xs text-gray-600 block mb-1">Destination week</span>
            <select
              value={copyWeekId}
              onChange={(e) => setCopyWeekId(e.target.value)}
              disabled={!copyStudentId || destWeeks.length === 0}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-50"
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
            className="flex-1 bg-primary text-white rounded-lg py-2 text-sm font-medium disabled:opacity-50"
          >
            {isPending ? 'Copying…' : 'Copy'}
          </button>
          <button
            onClick={handleClose}
            className="flex-1 bg-gray-100 text-gray-600 rounded-lg py-2 text-sm font-medium"
          >
            Cancel
          </button>
        </div>
      </div>
    </Dialog>
  );
}
