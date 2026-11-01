/**
 * JAV Code Normalization and Extraction Service
 * Normalizes formats like ADN-001, ADN_001, ADN 001, ADN001, #ADN-001, [ADN-001]
 * into standard uppercase 'ADN-001'.
 * Prevents arbitrary numbers from matching as JAV codes.
 */

// Regex matching typical JAV codes: 2-6 letters followed by optional delimiter and 2-5 digits
// e.g. ADN-001, ABP_978, STAR765, FC2-PPV-1234567, S2M-001, 1Pondo (some special prefixes)
const CODE_REGEX = /(?:#|\[|\b)([A-Za-z]{2,8}|[A-Za-z0-9]{2,4}-[A-Za-z0-9]{2,4})[-_\s]?(\d{2,6})(?:\]|\b)/gi;

export function normalizeCode(input: string): string | null {
  if (!input || typeof input !== 'string') return null;

  const cleaned = input.trim().toUpperCase();

  // Remove surrounding brackets or hashtags
  const stripped = cleaned.replace(/^[#\[(]+/, '').replace(/[\])]+$/, '');

  // Match pattern: Letters (or prefix with hyphen) + optional separator + digits
  const match = stripped.match(/^([A-Z]{2,8}|[A-Z0-9]{2,4}-[A-Z0-9]{2,4})[-_\s]?(\d{2,6})$/);
  if (!match) {
    return null;
  }

  const prefix = match[1].replace(/[-_]/g, '-');
  let numPart = match[2];

  // Standardize 3-digit padding if 2 digits (e.g. ADN-1 -> ADN-001, ADN-01 -> ADN-001)
  if (numPart.length < 3 && !prefix.includes('PPV')) {
    numPart = numPart.padStart(3, '0');
  }

  return `${prefix}-${numPart}`;
}

export function extractCodes(text: string): string[] {
  if (!text || typeof text !== 'string') return [];

  const foundCodes = new Set<string>();
  const matches = text.matchAll(CODE_REGEX);

  for (const match of matches) {
    const rawCandidate = match[0];
    const normalized = normalizeCode(rawCandidate);
    if (normalized) {
      foundCodes.add(normalized);
    }
  }

  // Also check if entire caption/text is a single code without boundaries
  if (foundCodes.size === 0) {
    const singleNorm = normalizeCode(text);
    if (singleNorm) {
      foundCodes.add(singleNorm);
    }
  }

  return Array.from(foundCodes);
}

export function isValidCode(code: string): boolean {
  return normalizeCode(code) !== null;
}

export function cleanActressList(rawActresses?: unknown): string[] {
  if (!Array.isArray(rawActresses)) return [];
  const invalidPatterns = [
    /\b(FHD|HD|SD|4K|2K|720p|1080p|Reducing|Mosaic)\b/i,
    /\d{1,2}:\d{2}(:\d{2})?/, // Durations like 01:42:17
    /\b[A-Z]{2,6}-\d{2,5}\b/i, // Codes like ROE-324, VEC-732
    /\b(slave|trip|pregnant|friend|wife|mother|creampie|stepson|girlfriend|sister|match)\b/i,
  ];

  const cleaned: string[] = [];
  for (const item of rawActresses) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > 40 || trimmed.length < 2) continue;
    if (invalidPatterns.some(pat => pat.test(trimmed))) continue;
    if (!cleaned.includes(trimmed)) {
      cleaned.push(trimmed);
    }
  }
  return cleaned;
}

export function cleanTitle(title: string, code: string): string {
  if (!title) return code;
  let clean = title.trim();
  const escapedCode = code.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  clean = clean.replace(new RegExp(`^${escapedCode}\\s*[-:—]?\\s*`, 'i'), '').trim();
  return clean || title;
}


/** Extracts a database video ID from Telegram /start payloads (legacy numeric IDs or UUIDs). */
export function extractVideoIdFromStartPayload(payload: string): string | null {
  const match = /^v_(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(payload.trim());
  return match?.[1] ?? null;
}

