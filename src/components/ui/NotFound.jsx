import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../../hooks/useI18n';
import { Button, LargeTitle } from '../parc';

/**
 * An address the app has no page for: says so, shows the address, and leads
 * to the home of the account's role.
 */
export default function NotFound() {
  const { t } = useI18n();
  const { role } = useAuth();
  const location = useLocation();
  const home = role === 'coach' ? '/coach/students' : '/student';

  return (
    <div className="flex flex-col gap-6 px-4 pt-3 pb-6 md:px-8">
      <LargeTitle title={t('parcFrame.notFoundTitle')} />
      <div className="flex max-w-md flex-col items-start gap-4">
        <p className="pk-body m-0">{t('parcFrame.notFoundBody')}</p>
        <p className="pk-small m-0 break-all">{t('parcFrame.notFoundAddress', { path: location.pathname || '/' })}</p>
        <Button as={Link} to={home} variant="primary">
          {t('parcFrame.goHome')}
        </Button>
      </div>
    </div>
  );
}
