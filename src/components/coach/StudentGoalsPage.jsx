import { useI18n } from '../../hooks/useI18n';
import AthleteSubPage from './AthleteSubPage';
import StudentGoalsSection from './StudentGoalsSection';

// The goals of one athlete, a page of its own: /coach/students/:studentId/goals.
export default function StudentGoalsPage() {
  const { t } = useI18n();
  return (
    <AthleteSubPage title={t('coach.tabs.goals')}>
      <StudentGoalsSection />
    </AthleteSubPage>
  );
}
