import { describe, expect, it } from 'vitest'
import { COMMAND_HELPS, USAGE, parseLmemoryCommand, renderHelp } from '../src/command.js'

describe('parseLmemoryCommand', () => {
  it('defaults to help for empty input', () => {
    expect(parseLmemoryCommand('')).toEqual({ kind: 'help' })
    expect(parseLmemoryCommand('  help ')).toEqual({ kind: 'help' })
  })

  it('parses help with an optional topic (lowercased)', () => {
    expect(parseLmemoryCommand('help stats')).toEqual({ kind: 'help', topic: 'stats' })
    expect(parseLmemoryCommand('help STATS')).toEqual({ kind: 'help', topic: 'stats' })
    expect(parseLmemoryCommand('help bogus')).toEqual({ kind: 'help', topic: 'bogus' })
  })

  it('parses status', () => {
    expect(parseLmemoryCommand('status')).toEqual({ kind: 'status' })
  })

  it('parses stats, usage, and ui', () => {
    expect(parseLmemoryCommand('stats')).toEqual({ kind: 'stats' })
    expect(parseLmemoryCommand('usage')).toEqual({ kind: 'usage' })
    expect(parseLmemoryCommand('usage --days 14')).toEqual({ kind: 'usage', days: 14 })
    expect(parseLmemoryCommand('usage --days bogus')).toEqual({ kind: 'usage' })
    expect(parseLmemoryCommand('usage --days')).toEqual({ kind: 'usage' })
    expect(parseLmemoryCommand('ui')).toEqual({ kind: 'ui' })
  })

  it('parses collections list/add/forget/export', () => {
    expect(parseLmemoryCommand('collections')).toEqual({ kind: 'collections', action: 'list' })
    expect(parseLmemoryCommand('collections list')).toEqual({ kind: 'collections', action: 'list' })
    expect(parseLmemoryCommand('collections add /path/to/lmemory')).toEqual({ kind: 'collections', action: 'add', root: '/path/to/lmemory' })
    expect(parseLmemoryCommand('collections forget /path/to/lmemory')).toEqual({ kind: 'collections', action: 'forget', root: '/path/to/lmemory' })
    expect(parseLmemoryCommand('collections export')).toEqual({ kind: 'collections', action: 'export' })
    expect(parseLmemoryCommand('collections export --out ~/backup')).toEqual({ kind: 'collections', action: 'export', outDir: '~/backup' })
    expect(parseLmemoryCommand('collections export --root /a --root /b')).toEqual({ kind: 'collections', action: 'export', roots: ['/a', '/b'] })
    expect(parseLmemoryCommand('collections bogus')).toEqual({ kind: 'help' })
  })

  it('parses team start/stop/restart', () => {
    expect(parseLmemoryCommand('team start')).toEqual({ kind: 'team', action: 'start' })
    expect(parseLmemoryCommand('team stop')).toEqual({ kind: 'team', action: 'stop' })
    expect(parseLmemoryCommand('team restart')).toEqual({ kind: 'team', action: 'restart' })
    expect(parseLmemoryCommand('team bogus')).toEqual({ kind: 'help' })
  })

  it('parses query with free-form text', () => {
    expect(parseLmemoryCommand('query 提交规范')).toEqual({ kind: 'query', text: '提交规范' })
    expect(parseLmemoryCommand('query a b c')).toEqual({ kind: 'query', text: 'a b c' })
  })

  it('parses config get/set', () => {
    expect(parseLmemoryCommand('config')).toEqual({ kind: 'config-get' })
    expect(parseLmemoryCommand('config get')).toEqual({ kind: 'config-get' })
    expect(parseLmemoryCommand('config get maxNodeKb')).toEqual({ kind: 'config-get', key: 'maxNodeKb' })
    expect(parseLmemoryCommand('config set maxNodeKb 800')).toEqual({ kind: 'config-set', key: 'maxNodeKb', value: '800' })
    expect(parseLmemoryCommand('config set rerankPrompt 按相关度排序')).toEqual({ kind: 'config-set', key: 'rerankPrompt', value: '按相关度排序' })
    expect(parseLmemoryCommand('config set')).toEqual({ kind: 'help' })
  })

  it('falls back to help for unknown heads', () => {
    expect(parseLmemoryCommand('wat')).toEqual({ kind: 'help' })
  })

  it('parses review with no filter', () => {
    expect(parseLmemoryCommand('review')).toEqual({ kind: 'review' })
  })

  it('parses review with a layer filter', () => {
    expect(parseLmemoryCommand('review project')).toEqual({ kind: 'review', filter: { kind: 'layer', value: 'project' } })
    expect(parseLmemoryCommand('review USER')).toEqual({ kind: 'review', filter: { kind: 'layer', value: 'user' } })
  })

  it('parses review with a domain filter', () => {
    expect(parseLmemoryCommand('review DurablePrefs')).toEqual({ kind: 'review', filter: { kind: 'domain', value: 'DurablePrefs' } })
  })

  it('falls back to help for an unrecognized review filter', () => {
    expect(parseLmemoryCommand('review bogus')).toEqual({ kind: 'help' })
  })

  it('parses catalog rebuild', () => {
    expect(parseLmemoryCommand('catalog rebuild')).toEqual({ kind: 'catalog' })
    expect(parseLmemoryCommand('catalog')).toEqual({ kind: 'help' })
    expect(parseLmemoryCommand('catalog bogus')).toEqual({ kind: 'help' })
  })

  it('parses catalog rebuild --root (path with spaces preserved)', () => {
    expect(parseLmemoryCommand('catalog rebuild --root ~/.dsh/lmemory/global')).toEqual({ kind: 'catalog', root: '~/.dsh/lmemory/global' })
    expect(parseLmemoryCommand('catalog rebuild --root /Users/me/My Project/.dsh/lmemory')).toEqual({ kind: 'catalog', root: '/Users/me/My Project/.dsh/lmemory' })
    expect(parseLmemoryCommand('catalog rebuild --root')).toEqual({ kind: 'catalog' })
  })
})

describe('renderHelp', () => {
  it('lists every command with its summary in the full help', () => {
    const full = renderHelp()
    expect(full).toContain(USAGE)
    expect(full).toContain('Commands:')
    for (const [name, help] of COMMAND_HELPS) {
      expect(full).toContain(name)
      expect(full).toContain(help.summary)
    }
  })

  it('renders a single command usage, summary, and details for a topic', () => {
    const detail = renderHelp('stats')
    expect(detail).toContain('/lmemory stats')
    expect(detail).toContain('纯文件读')
    expect(detail).toContain('示例:/lmemory stats')
    expect(detail).not.toContain('Commands:')
  })

  it('renders the unknown-command message for an unrecognized topic', () => {
    expect(renderHelp('bogus')).toContain('Unknown command "bogus"')
  })

  it('has a help entry for every parseable subcommand head', () => {
    // status / stats / usage / ui / team / query / config / review / catalog / collections / help 全部可查。
    for (const topic of ['status', 'stats', 'usage', 'ui', 'team', 'query', 'config', 'review', 'catalog', 'collections', 'help']) {
      expect(COMMAND_HELPS.has(topic)).toBe(true)
    }
  })
})
