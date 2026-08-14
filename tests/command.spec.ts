import { describe, expect, it } from 'vitest'
import { parseLmemoryCommand } from '../src/command.js'

describe('parseLmemoryCommand', () => {
  it('defaults to help for empty input', () => {
    expect(parseLmemoryCommand('')).toEqual({ kind: 'help' })
    expect(parseLmemoryCommand('  help ')).toEqual({ kind: 'help' })
  })

  it('parses status', () => {
    expect(parseLmemoryCommand('status')).toEqual({ kind: 'status' })
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
})
