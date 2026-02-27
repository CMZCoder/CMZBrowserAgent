export const USER_ACTION_REQUIRED_OPEN_TAG = '[USER_ACTION_REQUIRED]';
export const USER_ACTION_REQUIRED_CLOSE_TAG = '[/USER_ACTION_REQUIRED]';

interface ManualCheckpointInput {
  readonly source: 'cli' | 'extension';
  readonly role: 'user' | 'assistant' | 'system';
  readonly content: string;
  readonly manualCheckpoint?: boolean;
}

function hasUserActionRequiredTag(content: string): boolean {
  return /\[USER_ACTION_REQUIRED\]/i.test(content);
}

function wrapWithUserActionRequiredTag(content: string): string {
  const trimmed = content.trim();
  return `${USER_ACTION_REQUIRED_OPEN_TAG}\n${trimmed}\n${USER_ACTION_REQUIRED_CLOSE_TAG}`;
}

function looksLikeManualCheckpoint(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  const phraseMatches = [
    /\bmanual step\b/i,
    /\baction required\b/i,
    /\blog[ -]?in\b/i,
    /\bsign[ -]?in\b/i,
    /\b2fa\b/i,
    /\btwo[- ]factor\b/i,
    /\bcaptcha\b/i,
    /\bverification code\b/i,
    /\bapprove\b/i,
    /\bauthorize\b/i,
    /\bconfirm\b/i,
    /\benter code\b/i,
    /\bplease do this\b/i,
  ].some((pattern) => pattern.test(normalized));

  if (!phraseMatches) {
    return false;
  }

  const targetUserHint = /\b(you|your|please)\b/i.test(normalized);
  return targetUserHint || /\b(action required|manual step)\b/i.test(normalized);
}

export function normalizePromptContentForManualCheckpoint(input: ManualCheckpointInput): string {
  const trimmed = input.content.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (hasUserActionRequiredTag(trimmed)) {
    return trimmed;
  }

  if (input.role !== 'assistant' && input.role !== 'system') {
    return trimmed;
  }

  const shouldTagExplicitly = input.manualCheckpoint === true;
  const shouldTagAutomatically = input.source === 'cli' && input.manualCheckpoint !== false && looksLikeManualCheckpoint(trimmed);

  if (!shouldTagExplicitly && !shouldTagAutomatically) {
    return trimmed;
  }

  return wrapWithUserActionRequiredTag(trimmed);
}
