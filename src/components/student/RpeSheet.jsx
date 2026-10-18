import { useI18n } from '../../hooks/useI18n';
import { Sheet } from '../parc';
import RpeChoices from './RpeChoices';
import { useSetActions } from './useSetActions';

/**
 * The sheet that asks the RPE of the set just validated (screens/Seance.dc.html):
 * « RPE de la série 2 », 6 to 10 in half steps. A rating is written at the tap
 * and closes the sheet; « Fermer sans RPE » closes it with none. Either way
 * `onClose` lets the screen move on to the next set.
 *
 * Mounted per set (`key` = the set's id) by SessionView, so that the writes go
 * through that set's hooks; `exercise` is the editor context of its exercise
 * (useSetActions).
 */
export default function RpeSheet({ open, log, exercise, setNumber, onClose }) {
  const { t } = useI18n();
  const actions = useSetActions(log, exercise);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t('parcSession.rpeTitle', { n: setNumber })}
      description={t('parcSession.rpeScale')}
      closeLabel={t('parcSession.closeWithoutRpe')}
    >
      <RpeChoices
        value={log?.rpe}
        onChange={(rpe) => {
          if (rpe != null) actions?.rate(rpe);
          onClose();
        }}
      />
    </Sheet>
  );
}
