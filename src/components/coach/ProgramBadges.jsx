// What a block is, said in words next to its name (design/parc: a status is
// text, never a pill in capitals): « En cours » in blue for the block being
// trained, « Brouillon » or « Soumis » for an athlete's draft.

export function ActiveBadge({ t }) {
  return (
    <span className="shrink-0 text-[14px] font-semibold text-blue">{t('parcProgram.inProgress')}</span>
  );
}

/**
 * The badge reduced to its dot, for the picker's trigger where the block's
 * name is the headline and every pixel the badge takes is a pixel the name
 * loses. The word stays in the accessibility tree — being in progress must
 * not be carried by colour alone.
 */
export function ActiveDot({ t }) {
  return (
    <span className="inline-flex shrink-0 items-center">
      <span className="h-2 w-2 rounded-full bg-blue" aria-hidden="true" />
      <span className="sr-only">{t('parcProgram.inProgress')}</span>
    </span>
  );
}

export function DraftBadge({ submitted, t }) {
  return (
    <span className={`shrink-0 text-[14px] font-semibold ${submitted ? 'text-blue' : 'text-ink-2'}`}>
      {submitted ? t('parcProgram.submitted') : t('parcProgram.draft')}
    </span>
  );
}
