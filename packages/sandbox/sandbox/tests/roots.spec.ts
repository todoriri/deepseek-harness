/**
 * Tests for the writable-root derivation: the mode's meaning as a canonical
 * allow-list. Pinned here so the fs fence and the Seatbelt profile — both
 * deriving from `writableRoots` — cannot drift.
 */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalPath, writableRoots } from '@deepseek-ai/dsh-sandbox'

/** Every temp root created by this file, removed after each test. */
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('canonicalPath', () => {
  it('resolves symlinks (an existing path realpaths)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-roots-'))
    roots.push(dir)
    expect(canonicalPath(dir)).toBe(realpathSync.native(dir))
  })

  it('returns the spelling as-is when the path cannot be resolved (conservative — matches nothing until it exists)', () => {
    expect(canonicalPath('/does/not/exist/anywhere-xyz')).toBe('/does/not/exist/anywhere-xyz')
  })
})

describe('writableRoots', () => {
  it('read-only grants nothing', () => {
    expect(writableRoots({ mode: 'read-only', workspaceRoot: process.cwd() })).toEqual([])
  })

  it('workspace-write grants the workspace root plus the platform temp dir, canonical and deduplicated', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
    roots.push(ws)
    const writable = writableRoots({ mode: 'workspace-write', workspaceRoot: ws })
    expect(writable).toContain(realpathSync.native(ws))
    expect(writable).toContain(realpathSync.native(tmpdir()))
    // Deduplicated after canonicalization (the workspace and os.tmpdir() may coincide).
    expect(new Set(writable).size).toBe(writable.length)
  })

  it('the literal /tmp is granted exactly when os.tmpdir() IS /tmp — relocating TMPDIR closes the host-/tmp channel (review.16.10 F2, D134)', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
    roots.push(ws)
    const privateDir = mkdtempSync(join(tmpdir(), 'dsh-private-'))
    roots.push(privateDir)
    const prior = process.env.TMPDIR
    try {
      process.env.TMPDIR = privateDir
      const relocated = writableRoots({ mode: 'workspace-write', workspaceRoot: ws })
      // The caller's own temp dir is the temp area the mode promises …
      expect(relocated).toContain(realpathSync.native(privateDir))
      // … and the host's literal /tmp stops being a root the fence would admit.
      expect(relocated).not.toContain(canonicalPath('/tmp'))
    } finally {
      if (prior === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = prior
    }
    // Restored: os.tmpdir() (whatever it resolves to) is a root again, and /tmp with it whenever
    // the two are the same directory — the Linux default.
    const restored = writableRoots({ mode: 'workspace-write', workspaceRoot: ws })
    expect(restored).toContain(realpathSync.native(tmpdir()))
    expect(restored.includes(canonicalPath('/tmp'))).toBe(realpathSync.native(tmpdir()) === canonicalPath('/tmp'))
  })
})
