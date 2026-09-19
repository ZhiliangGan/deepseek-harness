import { describe, expect, it } from 'vitest'
import { extractJsonDocument } from '../src/extract.ts'

describe('extractJsonDocument', () => {
  it('parses a whole-text object or array', () => {
    expect(extractJsonDocument('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
    expect(extractJsonDocument('  [1,2]  ')).toEqual({ ok: true, value: [1, 2] })
  })

  it('strips one wrapping code fence', () => {
    expect(extractJsonDocument('```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } })
    expect(extractJsonDocument('```\n[1]\n```')).toEqual({ ok: true, value: [1] })
  })

  it('extracts the first balanced document from surrounding prose', () => {
    expect(extractJsonDocument('Sure:\n{"a":{"b":[2]}}\nbye'))
      .toEqual({ ok: true, value: { a: { b: [2] } } })
    expect(extractJsonDocument('leading [1,2] trailing {"a":1}'))
      .toEqual({ ok: true, value: [1, 2] })
  })

  it('ignores braces inside strings when scanning for the close', () => {
    expect(extractJsonDocument('{"a":"}\\"] not a close"}'))
      .toEqual({ ok: true, value: { a: '}"] not a close' } })
  })

  it('skips escaped characters inside strings while scanning', () => {
    expect(extractJsonDocument('prefix {"a":"say \\"hi\\""} suffix'))
      .toEqual({ ok: true, value: { a: 'say "hi"' } })
  })

  it('reports a stable error for prose without a document', () => {
    expect(extractJsonDocument('no structured content here'))
      .toEqual({ ok: false, error: 'the reply contains no JSON object or array' })
  })

  it('reports a stable error for an unclosed document', () => {
    expect(extractJsonDocument('{"a":'))
      .toEqual({ ok: false, error: 'the reply starts a JSON document but never closes it' })
  })

  it('reports a stable error for malformed JSON content', () => {
    expect(extractJsonDocument('{not json}'))
      .toEqual({ ok: false, error: 'the reply contains text that is not valid JSON' })
  })

  it('leaves scalar-only text unextracted (object or array roots only)', () => {
    expect(extractJsonDocument('42').ok).toBe(false)
    expect(extractJsonDocument('"quoted"').ok).toBe(false)
  })
})
