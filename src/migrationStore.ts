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

  const result = migrations
    .filter(m => m.previous >= version)
    .sort((a, b) => a.version - b.version)
    .reduce((acc, m) => {
      // Each step must start exactly where the chain has reached — starting below the oldest entry
      // or crossing a gap between entries would apply DDL over a schema shape that was never installed.
      assert(m.previous === acc.version,
        `Cannot migrate bun-boss schema from version ${version}: the chain reaches ${acc.version} but the next step starts at ${m.previous}.`)
      acc.install = acc.install.concat(m.install)
      acc.version = m.version
      return acc
    }, { install: [] as string[], version })

  assert(result.install.length > 0, `Version ${version} not found.`)

  return flatten(c, result.install, result.version, noAdvisoryLocks)
}
