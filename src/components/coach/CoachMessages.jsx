import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../../hooks/useI18n';
import { useStudents } from '../../hooks/useStudents';
import { useConversations } from '../../hooks/useMessages';
import UserMenu from '../ui/UserMenu';
import Spinner from '../ui/Spinner';
import ConversationList from '../messaging/ConversationList';
import MessageThread from '../messaging/MessageThread';
import { formatNumber, pluralKey } from '../../lib/i18n/format';
import { Avatar, IconButton, LargeTitle, ListGroup, Row, SearchField } from '../parc';

/**
 * Coach Messages tab. Two modes:
 *   /coach/messages                 → conversation roll-up
 *   /coach/messages/:otherProfileId → thread with that student
 *
 * The roll-up is fed by `useConversations`; for new messages the coach picks
 * a student via the row of "start a conversation" cards rendered when no
 * thread exists yet for that student.
 */
export default function CoachMessages() {
  const { otherProfileId } = useParams();
  const { profile, signOut } = useAuth();
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const { data: students } = useStudents();
  const { data: conversations } = useConversations();

  // The thread view needs the counterpart's display name. We get it from the
  // students list (coach's full roster) since the conversations rollup only
  // covers students with at least one message exchanged.
  const counterpart = useMemo(() => {
    if (!otherProfileId) return null;
    const s = (students || []).find((x) => x.profile_id === otherProfileId);
    if (s) return { id: s.profile_id, full_name: s.profile?.full_name, studentRowId: s.id };
    const c = (conversations || []).find((x) => x.otherProfileId === otherProfileId);
    if (c) return { id: c.otherProfileId, full_name: c.otherFullName };
    return null;
  }, [otherProfileId, students, conversations]);

  // Students with no message history — surface them so the coach can start
  // a conversation. Skips the currently-open thread.
  const startable = useMemo(() => {
    if (otherProfileId) return [];
    const seen = new Set((conversations || []).map((c) => c.otherProfileId));
    return (students || [])
      .filter((s) => !seen.has(s.profile_id))
      .map((s) => ({ profileId: s.profile_id, fullName: (s.profile?.full_name || '').trim() || t('parcMessages.unnamedAthlete') }));
  }, [students, conversations, otherProfileId, t]);

  if (otherProfileId) {
    const name = (counterpart?.full_name || '').trim() || t('parcMessages.unknown');
    // The conversation (design/parc/screens/Conversation.dc.html): back to
    // the list, the athlete's name in the middle, and their page behind their
    // initials at the right.
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-3 border-b border-line-strong px-4 py-3 md:px-8">
          <IconButton icon="chevron-left" label={t('parcMessages.back')} onClick={() => navigate('/coach/messages')} />
          <h1 className="pk-headline min-w-0 flex-1 truncate text-center">{name}</h1>
          {counterpart?.studentRowId ? (
            <Link
              to={`/coach/students/${counterpart.studentRowId}`}
              aria-label={t('parcMessages.seeAthlete', { name })}
              className="shrink-0 rounded-full"
            >
              <Avatar name={name} />
            </Link>
          ) : (
            <span className="w-11 shrink-0" aria-hidden="true" />
          )}
        </header>

        <div className="flex min-h-0 flex-1">
          <MessageThread otherProfileId={otherProfileId} otherFullName={counterpart?.full_name} className="w-full" />
        </div>
      </div>
    );
  }

  // The search keeps the athletes it names, with or without a conversation.
  const q = query.trim().toLowerCase();
  const startableShown = q ? startable.filter((s) => s.fullName.toLowerCase().includes(q)) : startable;
  const unreadConversations = (conversations || []).filter((c) => c.unreadCount > 0).length;
  const subtitle = conversations
    ? unreadConversations > 0
      ? t(pluralKey(lang, unreadConversations, 'parcMessages.unread'), { n: formatNumber(lang, unreadConversations) })
      : t('parcMessages.allRead')
    : null;

  return (
    <div className="flex flex-col gap-6 px-4 pt-3 pb-6 md:px-8">
      <LargeTitle
        title={t('parcMessages.title')}
        subtitle={subtitle}
        trailing={<UserMenu fullName={profile?.full_name} onSignOut={signOut} />}
      />

      {!students && (
        <div className="flex justify-center py-12"><Spinner /></div>
      )}

      {students && students.length === 0 && (
        <p className="rounded-group bg-surface p-4 pk-body">{t('parcMessages.noAthlete')}</p>
      )}

      {students && students.length > 0 && (
        <>
          {(conversations || []).length > 0 && (
            <SearchField label={t('parcMessages.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
          )}

          <ConversationList
            linkBuilder={(c) => `/coach/messages/${c.otherProfileId}`}
            emptyMessage={t('parcMessages.noConversation')}
            query={query}
          />

          {startableShown.length > 0 && (
            <ListGroup title={t('parcMessages.startNew')}>
              {startableShown.map((s) => (
                <Row
                  key={s.profileId}
                  to={`/coach/messages/${s.profileId}`}
                  leading={<Avatar name={s.fullName} />}
                  title={s.fullName}
                />
              ))}
            </ListGroup>
          )}
        </>
      )}
    </div>
  );
}
