import { useState } from 'react';
import { useI18n } from '../../hooks/useI18n';
import { useStudentRecords } from '../../hooks/useStudentRecords';
import { formatDate, formatNumber, pluralKey } from '../../lib/i18n/format';
import Spinner from '../ui/Spinner';
import { Button, ListGroup, Row } from '../parc';

// How many records the list shows before « Voir les n autres records ».
const SHOWN = 5;

// The id of the bodyweight card's title, which the nudge below scrolls to.
export const BODYWEIGHT_HEADING_ID = 'stats-bodyweight-heading';

/**
 * The athlete's records (design/parc/screens/Stats.dc.html, « Records »): one
 * row per exercise — its name, when the record was set (« Nouveau record » in
 * blue while it is recent) with the set it came from and the strength
 * relative to bodyweight, and at the right the figure in condensed digits: the
 * estimated one-rep max, or the most reps in a row for an exercise without a
 * load. Five, then « Voir les n autres records ».
 *
 * An athlete with an exercise lifted with added load and no bodyweight logged
 * is offered to log it: the ×BW figure needs it (`bwAtBest`).
 */
export default function PersonalRecords({ studentRowId }) {
  const { t, lang } = useI18n();
  const { data: records, isLoading } = useStudentRecords(studentRowId);
  const [showAll, setShowAll] = useState(false);
  const list = records || [];
  const shown = showAll ? list : list.slice(0, SHOWN);
  const hidden = list.length - shown.length;

  const showBwNudge =
    !studentRowId && list.some((r) => r.bestE1rm && r.loadMode === 'added' && r.bwAtBest == null);

  function scrollToBodyweight() {
    document.getElementById(BODYWEIGHT_HEADING_ID)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  const day = (at) => (at ? formatDate(lang, at, { day: 'numeric', month: 'long' }) : null);

  return (
    <ListGroup title={t('parcStats.records')} aside={list.length > 0 ? t('parcStats.recordsAside') : null}>
      {isLoading ? (
        <li className="flex justify-center py-4">
          <Spinner />
        </li>
      ) : list.length === 0 ? (
        <li className="pk-row">
          <span className="pk-caption">{t('parcStats.recordsEmpty')}</span>
        </li>
      ) : (
        <>
          {shown.map((r) => {
            const isAdded = r.loadMode === 'added';
            const at = day(r.bestE1rm ? r.bestE1rmAt : r.bestRepsAt);
            const set = r.bestE1rm
              ? t('parcStats.recordSet', {
                  reps: formatNumber(lang, r.bestE1rmReps),
                  kg: formatNumber(lang, r.bestE1rmWeight),
                })
              : null;
            const facts = [
              set,
              r.relStrength != null
                ? t('parcStats.relStrength', { mult: formatNumber(lang, r.relStrength, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })
                : null,
            ].filter(Boolean);
            const when = r.recent ? (
              <span className="font-semibold text-blue">
                {at ? t('parcStats.recordNewOn', { date: at }) : t('parcStats.recordNew')}
              </span>
            ) : at ? (
              t('parcStats.recordOn', { date: at })
            ) : null;
            return (
              <Row
                key={r.exercise_id}
                title={r.name}
                subtitle={
                  when || facts.length > 0 ? (
                    <>
                      {when}
                      {facts.length > 0 && `${when ? ', ' : ''}${facts.join(', ')}`}
                    </>
                  ) : null
                }
                trailing={
                  <RecordFigure
                    value={formatNumber(lang, r.bestE1rm ?? r.bestReps)}
                    unit={
                      r.bestE1rm
                        ? t(isAdded ? 'parcStats.unitE1rmAdded' : 'parcStats.unitE1rm')
                        : t(pluralKey(lang, r.bestReps, 'parcStats.unitRepsInRow'))
                    }
                  />
                }
              />
            );
          })}
          {hidden > 0 && (
            <Row
              onClick={() => setShowAll(true)}
              title={
                <span className="text-blue">
                  {t(pluralKey(lang, hidden, 'parcStats.showMoreRecords'), { n: formatNumber(lang, hidden) })}
                </span>
              }
            />
          )}
          {showBwNudge && (
            <li className="py-2">
              <Button variant="text" className="text-left" onClick={scrollToBodyweight}>
                {t('parcStats.bwNudge')}
              </Button>
            </li>
          )}
        </>
      )}
    </ListGroup>
  );
}

function RecordFigure({ value, unit }) {
  return (
    <span className="shrink-0 text-right">
      <span className="pk-condensed pk-tnum block text-[28px] font-extrabold leading-none">{value}</span>
      <span className="pk-small">{unit}</span>
    </span>
  );
}
