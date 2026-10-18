import { useMemo, useState } from 'react';
import { useStudents } from '../../hooks/useStudents';
import { useProgramsForStudent, useProgram } from '../../hooks/useProgram';
import { useI18n } from '../../hooks/useI18n';
import { flattenSessions } from '../../lib/sessionQueue';
import { formatNumber } from '../../lib/i18n/format';
import { Button, SelectField, Sheet } from '../parc';

// The places the sessions of each phase hold in the block, `{ from, to }` by
// phase id, numbered across phases as the Programming sheet numbers them; an
// archived session holds none, and a phase without a session is not in it.
function placesByPhase(weeks) {
  const places = new Map();
  let n = 0;
  for (const { session, week } of flattenSessions(weeks)) {
    if (session.archived_at) continue;
    n += 1;
    const place = places.get(week.id);
    if (place) place.to = n;
    else places.set(week.id, { from: n, to: n });
  }
  return places;
}

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
 * once the copy is made. `Sheet` mounts its children only while it is open,
 * so the three selects live in `CopyForm` and go with it. Copy does NOT clear
 * them: the parent closes the dialog when the copy succeeds, and a copy that
 * is refused leaves it open with the destination still chosen, to be sent
 * again.
 */
export default function CopyDialog({ open, onClose, title, description, ...form }) {
  return (
    <Sheet open={open} onClose={onClose} title={title} description={description}>
      <CopyForm onClose={onClose} {...form} />
    </Sheet>
  );
}

function CopyForm({
  onClose,
  currentStudentId,
  currentProgramId,
  showWeekSelect = false,
  onCopy,
  isPending = false,
}) {
  const { t, lang } = useI18n();
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
  const destWeeks = useMemo(() => destProgram?.weeks || [], [destProgram]);
  const weekId = programId && destWeeks.some((w) => w.id === copyWeekId) ? copyWeekId : '';
  const places = useMemo(() => placesByPhase(destWeeks), [destWeeks]);

  // A phase as the sheet names it — never "Week 3": a phase is a free-text
  // name, and an unnamed one is drawn as such (review item B28). The sessions
  // it holds tell two phases of the same name apart.
  // A phase is named by its name — or « Phase sans nom » — and the places its
  // sessions hold in the block, never « Week n ».
  function phaseOption(week) {
    const name = week.label || t('parcProgram.phaseUnnamed');
    const place = places.get(week.id);
    const fmt = (n) => formatNumber(lang, n);
    const holds = !place
      ? t('parcProgram.phaseEmpty')
      : place.from === place.to
        ? t('parcProgram.phaseOne', { n: fmt(place.from) })
        : t('parcProgram.phaseRange', { from: fmt(place.from), to: fmt(place.to) });
    return t('parcProgram.copyPhaseOption', { name, holds });
  }

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

  return (
    <div className="flex flex-col gap-4">
      <SelectField
        label={t('parcProgram.copyAthlete')}
        value={copyStudentId}
        onChange={(e) => {
          setCopyStudentId(e.target.value);
          setCopyProgramId('');
          setCopyWeekId('');
        }}
      >
        <option value="">{t('parcProgram.copyChooseAthlete')}</option>
        {(students || [])
          .filter((s) => currentProgramId || s.id !== currentStudentId)
          .map((s) => {
            const name = (s.profile?.full_name || '').trim() || t('parcProgram.copyUnnamed');
            return (
              <option key={s.id} value={s.id}>
                {s.id === currentStudentId ? t('parcProgram.copyThisAthlete', { name }) : name}
              </option>
            );
          })}
      </SelectField>

      <SelectField
        label={t('parcProgram.copyBlock')}
        value={programId}
        onChange={(e) => {
          setCopyProgramId(e.target.value);
          setCopyWeekId('');
        }}
        disabled={!copyStudentId || (destPrograms || []).length === 0}
      >
        <option value="">
          {!copyStudentId
            ? t('parcProgram.copyChooseAthleteFirst')
            : (destPrograms || []).length === 0
              ? t('parcProgram.copyNoBlock')
              : t('parcProgram.copyChooseBlock')}
        </option>
        {(destPrograms || []).map((p) => (
          <option key={p.id} value={p.id}>
            {p.is_active ? t('parcProgram.copyBlockInProgress', { name: p.name }) : p.name}
          </option>
        ))}
      </SelectField>

      {showWeekSelect && (
        <SelectField
          label={t('parcProgram.copyPhase')}
          value={weekId}
          onChange={(e) => setCopyWeekId(e.target.value)}
          disabled={!programId || destWeeks.length === 0}
        >
          <option value="">
            {!programId
              ? t('parcProgram.copyChooseBlockFirst')
              : destWeeks.length === 0
                ? t('parcProgram.copyNoPhase')
                : t('parcProgram.copyChoosePhase')}
          </option>
          {destWeeks.map((w) => (
            <option key={w.id} value={w.id}>
              {phaseOption(w)}
            </option>
          ))}
        </SelectField>
      )}

      <div className="mt-1 flex flex-col gap-1">
        <Button variant="primary" size="lg" onClick={handleCopy} disabled={copyDisabled}>
          {isPending ? t('parcProgram.copying') : t('parcProgram.copy')}
        </Button>
        <Button variant="text" onClick={onClose}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}
