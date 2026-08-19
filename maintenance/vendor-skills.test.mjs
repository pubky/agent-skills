#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fromGit } from './vendor-skills.mjs'

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
const root = mkdtempSync(join(tmpdir(), 'vendor-skills-test-'))

try {
  const origin = join(root, 'origin.git')
  const author = join(root, 'author')
  const cacheDir = join(root, 'cache')
  const clone = join(cacheDir, 'nexus-scout')

  mkdirSync(author)
  git(author, ['init', '--quiet'])
  git(root, ['init', '--bare', '--quiet', origin])
  git(author, ['config', 'user.name', 'Vendor Test'])
  git(author, ['config', 'user.email', 'vendor-test@example.com'])

  writeFileSync(join(author, 'SKILL.md'), '# Version one\n')
  git(author, ['add', 'SKILL.md'])
  git(author, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'version one'])
  git(author, ['branch', '-M', 'main'])
  git(author, ['remote', 'add', 'origin', origin])
  git(author, ['push', '--quiet', '-u', 'origin', 'main'])

  mkdirSync(cacheDir)
  git(root, ['clone', '--quiet', '--branch', 'main', origin, clone])
  const staleHead = git(clone, ['rev-parse', 'HEAD'])

  writeFileSync(join(author, 'SKILL.md'), '# Version two\n')
  git(author, ['add', 'SKILL.md'])
  git(author, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'version two'])
  git(author, ['push', '--quiet'])

  writeFileSync(join(clone, 'SKILL.md'), '# Dirty worktree\n')
  const got = fromGit(
    { repo: 'nexus-scout', path: 'SKILL.md' },
    { cacheDir, repos: { 'nexus-scout': { branch: 'main' } } },
  )

  assert.equal(got?.body, '# Version two\n')
  assert.equal(git(clone, ['rev-parse', 'HEAD']), staleHead)
  assert.equal(readFileSync(join(clone, 'SKILL.md'), 'utf8'), '# Dirty worktree\n')
  console.log('✓ fromGit refreshes stale sources and ignores dirty worktrees')
} finally {
  rmSync(root, { recursive: true, force: true })
}
