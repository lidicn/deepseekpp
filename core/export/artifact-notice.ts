import type { ConversationExport } from './types';

/**
 * DPP-01 ruling A: a capped export must announce the cap in every artifact the
 * user receives. A filled cap cannot prove the account had no more sessions, so
 * the wording says "may have more" rather than claiming a complete export.
 */
export function sessionLimitNotice(exportData: ConversationExport): string | null {
  if (!exportData.stats.truncatedBySessionLimit) return null;
  const { sessionCount } = exportData.stats;
  const limit = exportData.request.sessionLimit ?? sessionCount;
  return (
    `This export stopped at the session limit (${sessionCount} of ${limit} sessions). ` +
    'Your account may have more conversations; export it in smaller ranges to reach the rest.'
  );
}
