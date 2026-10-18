import { useI18n } from '../../hooks/useI18n';
import AthleteSubPage from './AthleteSubPage';
import StudentStatsSection from './StudentStatsSection';

// The stats of one athlete, a page of its own: /coach/students/:studentId/stats.
// Its heavy read starts when the page opens, as it did when its section was
// opened on the athlete page.
export default function StudentStatsPage() {
  const { t } = useI18n();
  return (
    <AthleteSubPage title={t('coach.tabs.stats')}>
      <StudentStatsSection />
    </AthleteSubPage>
  );
}
