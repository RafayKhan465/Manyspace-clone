// Decides which automation (if any) a comment or DM should trigger.

const MATCH_MODES = ['keywords', 'exact', 'any'];
const TRIGGER_TYPES = ['comment', 'dm'];

function fold(s) {
  // Lowercase and strip accents so "Línk" matches "link".
  return String(s || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

// Letters and digits only, single-spaced: "LINK!!  please" -> "link please".
function words(s) {
  return fold(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Whole-word match, so "link" matches "send the LINK pls" but not "blinking".
// Keywords made only of emoji/symbols (e.g. "🔥") fall back to a substring match.
export function containsKeyword(text, keyword) {
  const k = words(keyword);
  if (!k) {
    const raw = fold(keyword).trim();
    return raw.length > 0 && fold(text).includes(raw);
  }
  return ` ${words(text)} `.includes(` ${k} `);
}

export function equalsKeyword(text, keyword) {
  const k = words(keyword);
  if (!k) {
    const raw = fold(keyword).trim();
    return raw.length > 0 && fold(text).trim() === raw;
  }
  return words(text) === k;
}

export function matches(automation, { type, text, mediaId }) {
  if (!automation.enabled) return false;
  if (automation.triggerType !== type) return false;
  if (type === 'comment' && automation.mediaIds.length > 0 && !automation.mediaIds.includes(mediaId)) return false;
  switch (automation.matchMode) {
    case 'any':
      return true;
    case 'exact':
      return automation.keywords.some((k) => equalsKeyword(text, k));
    case 'keywords':
      return automation.keywords.some((k) => containsKeyword(text, k));
    default:
      return false;
  }
}

// More specific automations win: a post-specific keyword rule beats a global
// keyword rule, which beats a catch-all. Ties go to the oldest automation.
function specificity(a) {
  return (a.mediaIds.length > 0 ? 2 : 0) + (a.matchMode !== 'any' ? 1 : 0);
}

export function pickAutomation(automations, event) {
  const candidates = automations.filter((a) => matches(a, event));
  if (candidates.length === 0) return null;
  return candidates.reduce((best, a) => (specificity(a) > specificity(best) ? a : best));
}

// ---- Validation of automations submitted from the dashboard ----

const MAX_DM_LENGTH = 1000; // Instagram's limit for text messages
const MAX_BUTTON_TEXT_LENGTH = 640; // limit for button template text
const MAX_BUTTON_TITLE_LENGTH = 20;

function cleanList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((v) => String(v).trim()).filter(Boolean))];
}

export function validateAutomation(input) {
  const errors = [];
  const a = {
    name: String(input.name || '').trim(),
    enabled: input.enabled !== false,
    triggerType: input.triggerType || 'comment',
    mediaIds: cleanList(input.mediaIds),
    matchMode: input.matchMode || 'keywords',
    keywords: cleanList(input.keywords),
    dmText: String(input.dmText || '').trim(),
    buttonTitle: String(input.buttonTitle || '').trim(),
    buttonUrl: String(input.buttonUrl || '').trim(),
    publicReplies: cleanList(input.publicReplies),
    oncePerUser: Boolean(input.oncePerUser),
  };

  if (!a.name) errors.push('Give the automation a name.');
  if (!TRIGGER_TYPES.includes(a.triggerType)) errors.push('Trigger must be "comment" or "dm".');
  if (!MATCH_MODES.includes(a.matchMode)) errors.push('Match mode must be "keywords", "exact" or "any".');
  if (a.matchMode !== 'any' && a.keywords.length === 0) errors.push('Add at least one keyword (or choose "any comment").');
  if (a.triggerType === 'dm') {
    a.mediaIds = [];
    a.publicReplies = [];
  }

  if (!a.dmText) errors.push('Write the DM to send.');
  const hasButton = a.buttonTitle || a.buttonUrl;
  if (hasButton) {
    if (!a.buttonTitle || !a.buttonUrl) errors.push('A button needs both a label and a link.');
    if (a.buttonTitle.length > MAX_BUTTON_TITLE_LENGTH) errors.push(`Button label must be at most ${MAX_BUTTON_TITLE_LENGTH} characters.`);
    if (a.buttonUrl && !/^https:\/\/\S+$/i.test(a.buttonUrl)) errors.push('Button link must start with https://');
    if (a.dmText.length > MAX_BUTTON_TEXT_LENGTH) errors.push(`With a button, the DM can be at most ${MAX_BUTTON_TEXT_LENGTH} characters.`);
  } else if (a.dmText.length > MAX_DM_LENGTH) {
    errors.push(`The DM can be at most ${MAX_DM_LENGTH} characters.`);
  }
  if (a.publicReplies.some((r) => r.length > 300)) errors.push('Public replies must be at most 300 characters.');

  return { automation: a, errors };
}
