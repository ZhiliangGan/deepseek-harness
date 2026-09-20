import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillReasoning from '@deepseek-ai/dsh-skill-reasoning'
import { describe, expect, it } from 'vitest'

const assets = fileURLToPath(new URL('../assets/', import.meta.url))
const names = ['best-of-n-sampling', 'collaborative-debate', 'decompose-first', 'program-first', 'tree-search']

describe('bundled reasoning skills', () => {
  it('loads each packaged body and removes all candidates on disposal', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SkillRegistry)
      const fiber = await ctx.plugin(SkillReasoning)
      const catalog = await ctx.skills.list()
      expect(catalog.map(skill => skill.name)).toEqual([...names].sort())
      for (const skill of catalog) {
        expect(skill.description.length).toBeLessThanOrEqual(500)
        expect(skill).toMatchObject({ source: 'bundled', provider: 'dsh-reasoning', invocation: { modelInvocable: true, userInvocable: true } })
        const loaded = await ctx.skills.get(skill.name)
        expect(loaded?.resourceBase).toEqual({ kind: 'directory', path: join(assets, skill.name) })
        const raw = await readFile(join(assets, skill.name, 'SKILL.md'), 'utf8')
        expect(loaded?.content).toBe(raw.slice(raw.indexOf('\n---\n') + 5).trim())
      }
      await fiber.dispose()
      expect(await ctx.skills.list()).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('loads relocated resources through a real cordis.yml composition', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-reasoning-skills-'))
    const ctx = new Context()
    try {
      const external = join(root, 'relocated assets')
      await cp(assets, external, { recursive: true })
      const configPath = join(root, 'cordis.yml')
      await writeFile(configPath, [
        "- name: '@deepseek-ai/dsh-skill'",
        "- name: '@deepseek-ai/dsh-skill-reasoning'",
        '  config:',
        `    assetRoot: ${JSON.stringify(external)}`,
        '',
      ].join('\n'))
      ctx.baseUrl = pathToFileURL(root).href + '/'
      await ctx.plugin(Loader)
      ctx.loader.builtins.include = Include
      const modules = new Map<string, unknown>([
        ['@deepseek-ai/dsh-skill', SkillRegistry],
        ['@deepseek-ai/dsh-skill-reasoning', SkillReasoning],
      ])
      ctx.loader.internal = {
        version: 'v2',
        async import(specifier: string) {
          if (!modules.has(specifier)) throw new Error(`Unexpected Loader import: ${specifier}`)
          return modules.get(specifier)
        },
      } as unknown as NonNullable<typeof ctx.loader.internal>
      await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
      await ctx.loader.await()
      expect((await ctx.skills.list()).map(skill => skill.name)).toEqual([...names].sort())
      const loaded = await ctx.skills.get('best-of-n-sampling')
      expect(loaded?.resourceBase).toEqual({ kind: 'directory', path: join(external, 'best-of-n-sampling') })
      const raw = await readFile(join(external, 'best-of-n-sampling', 'SKILL.md'), 'utf8')
      expect(loaded?.content).toBe(raw.slice(raw.indexOf('\n---\n') + 5).trim())
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['description: "Quoted: description"', '\r\n', 'Quoted: description'],
    ['description: >-\n  Folded\n  description', '\n', 'Folded description'],
  ])('parses frontmatter %s and leaves body metadata-like lines intact', async (header, newline, description) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-reasoning-metadata-'))
    const ctx = new Context()
    try {
      await cp(assets, root, { recursive: true })
      const body = '# Reasoning instructions\n\ndescription: instruction text'
      await writeFile(join(root, 'program-first', 'SKILL.md'), `---\n${header}\n---\n\n${body}\n`.replaceAll('\n', newline))
      await ctx.plugin(SkillRegistry)
      await ctx.plugin(SkillReasoning, { assetRoot: root })
      const skill = await ctx.skills.get('program-first')
      expect(skill?.description).toBe(description)
      expect(skill?.content).toBe(body.replaceAll('\n', newline))
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects relative resource paths and incomplete asset trees before registration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-reasoning-invalid-'))
    const ctx = new Context()
    try {
      await ctx.plugin(SkillRegistry)
      expect(() => { SkillReasoning.apply(ctx, { assetRoot: 'assets' }) }).toThrow('absolute directory')
      await cp(assets, root, { recursive: true })
      await writeFile(join(root, 'program-first', 'SKILL.md'), '# Missing frontmatter\ndescription: body text\n')
      expect(() => { SkillReasoning.apply(ctx, { assetRoot: root }) }).toThrow('has no YAML frontmatter')
      for (const header of ['', 'null', 'scalar', 'name: program-first', 'description: 3', 'description: ""']) {
        await writeFile(join(root, 'program-first', 'SKILL.md'), `---\n${header}\n---\n# Instructions\n`)
        expect(() => { SkillReasoning.apply(ctx, { assetRoot: root }) }).toThrow('has no description')
      }
      expect(await ctx.skills.list()).toEqual([])
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
