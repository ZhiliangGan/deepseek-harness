/**
 * Pure JSON-document extraction from one assistant text: whole-text parse,
 * then a single stripped code fence, then the first balanced object/array
 * substring. String-aware brace scanning keeps quoted braces from ending the
 * document early.
 *
 * @module @deepseek-ai/dsh-structured-output/extract
 */

/** One extraction attempt: a parsed JSON value or a stable failure account. */
export type JsonExtraction =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string }

/** Strip at most one wrapping Markdown code fence from the trimmed text. */
function stripFence(text: string): string {
  const fence = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```$/.exec(text)
  return fence?.[1] ?? text
}

/**
 * Extract the first JSON document embedded in one assistant text.
 * @param text - the turn's final assistant text.
 * @returns the parsed JSON value, or a stable error naming the failure.
 */
export function extractJsonDocument(text: string): JsonExtraction {
  const trimmed = stripFence(text.trim())
  const direct = tryParse(trimmed)
  if (direct !== undefined) return { ok: true, value: direct }
  const start = firstDocumentStart(trimmed)
  if (start === -1) {
    return { ok: false, error: 'the reply contains no JSON object or array' }
  }
  const end = balancedEnd(trimmed, start)
  if (end === -1) {
    return { ok: false, error: 'the reply starts a JSON document but never closes it' }
  }
  const sliced = tryParse(trimmed.slice(start, end + 1))
  if (sliced === undefined) {
    return { ok: false, error: 'the reply contains text that is not valid JSON' }
  }
  return { ok: true, value: sliced }
}

/** Parse one candidate or return undefined, without throwing. */
function tryParse(candidate: string): unknown {
  if (!candidate.startsWith('{') && !candidate.startsWith('[')) return undefined
  try {
    return JSON.parse(candidate) as unknown
  } catch (_malformedJson) {
    return undefined
  }
}

/** Index of the first `{` or `[` that could open a JSON document. */
function firstDocumentStart(text: string): number {
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === '{' || char === '[') return index
  }
  return -1
}

/**
 * Index of the character closing the document opened at `start`, honoring
 * string literals (with escapes) and one level of nesting brackets; `-1` when
 * the document never closes.
 */
function balancedEnd(text: string, start: number): number {
  const open = text[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (char === '\\') index++
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === open) depth++
    else if (char === close) {
      depth--
      if (depth === 0) return index
    }
  }
  return -1
}
