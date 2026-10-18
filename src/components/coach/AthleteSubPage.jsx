import { useOutletContext } from 'react-router-dom';
import { useI18n } from '../../hooks/useI18n';
import { useBackOr } from '../../hooks/useBackOr';
import { LargeTitle } from '../parc';

/**
 * A page of one athlete that is not their block — Goals, Stats — opened from
 * the links under the athlete page's title: its own title, the athlete on the
 * line under it, the account menu, and the way back to the athlete.
 *
 * The athlete page is the only way in, so back is one step back: the block
 * the coach was on (`?program=`) and the place in it come back with it. On the
 * first entry of the tab — an old link to `…/goals` — it is the athlete page.
 */
export default function AthleteSubPage({ title, children }) {
  const { t } = useI18n();
  const { student, athleteName = '', titleProps } = useOutletContext();
  const goBack = useBackOr(`/coach/students/${student.id}`);

  return (
    <div className="flex flex-col gap-6">
      <LargeTitle
        back={{ label: t('coachAthleteBlock.backTo', { name: athleteName }), onClick: goBack }}
        actions={titleProps?.actions}
        title={title}
        subtitle={athleteName}
      />
      {children}
    </div>
  );
}
