import assert from 'node:assert'
import * as plans from './plans.ts'
import type { Ctx } from './dialect.ts'
import type * as types from './types.ts'

interface GetAllOptions {
  noTablePartitioning?: boolean
  noCoveringIndexes?: boolean
}

// Empty at the v1 install floor — bun-boss installs fresh at package.json `bunboss.schema`, so
// there is no prior version to climb from. A future schema bump appends one entry rendered through
// the dialect seam (qn(c, ...)) so it serves both backends.
export function getAll (c: Ctx, options: GetAllOptions = {}): types.Migration[] {
  return []
}

export function getMinVersion (c: Ctx): number {
  const all = getAll(c)
  return all.length ? Math.min(...all.map(m => m.previous)) : Infinity
}

// assertMigration runs first so a lost race aborts the transaction before the install DDL re-applies.
function flatten (c: Ctx, commands: string[], version: number, noAdvisoryLocks?: boolean): string {
  return plans.locked(
    c,
    [plans.assertMigration(c, version), ...commands, plans.setVersion(c, version)],
    undefined,
    noAdvisoryLocks
  )
}

export function migrate (c: Ctx, version: number, migrations?: types.Migration[], noAdvisoryLocks?: boolean): string {
  migrations = migrations || getAll(c)

  // Refuse to climb from below the oldest entry, which would otherwise apply steps over schema that
  // was never installed; version 0 is the from-scratch sentinel and is exempt.
  if (Number.isInteger(version) && version !== 0 && migrations.length) {
    const minPrevious = Math.min(...migrations.map(m => m.previous))
    assert(version >= minPrevious,
      `Cannot migrate bun-boss schema from version ${version}: the oldest supported starting version is ${minPrevious}.`)
  }

  const result = migrations
    .filter(m => m.previous >= version)
    .sort((a, b) => a.version - b.version)
    .reduce((acc, m) => {
      acc.install = acc.install.concat(m.install)
      acc.version = m.version
      return acc
    }, { install: [] as string[], version })

  assert(result.install.length > 0, `Version ${version} not found.`)

  return flatten(c, result.install, result.version, noAdvisoryLocks)
}
