import assert from 'node:assert'
import * as plans from './plans.ts'
import type { Ctx } from './dialect.ts'
import type * as types from './types.ts'

interface GetAllOptions {
  noTablePartitioning?: boolean
  noCoveringIndexes?: boolean
}

// Ordered upgrade chain. EMPTY today: bun-boss installs fresh at package.json `bunboss.schema`
// (= 1, the install floor), so there is no historical version to climb from. A future schema bump
// appends one dialect-aware entry here, rendering DDL through the seam so it serves both backends:
//
//   { release: '1.2.0', version: 2, previous: 1,
//     install: [ `ALTER TABLE ${qn(c, 'version')} ADD COLUMN ...` ] }   // import { qn } from './dialect.ts'
//
// `c` is threaded now so those entries can render per-dialect (qn(c, ...), dial(c).now(), ...).
// Install DDL is SYNCHRONOUS ONLY — the async/CONCURRENTLY BAM path was intentionally dropped and
// must not return. `options` mirrors the schema-shape knobs of plans.create for entries whose DDL
// differs by shape; unused while the list is empty.
export function getAll (c: Ctx, options: GetAllOptions = {}): types.Migration[] {
  return []
}

export function getMinVersion (c: Ctx): number {
  const all = getAll(c)
  return all.length ? Math.min(...all.map(m => m.previous)) : Infinity
}

// Wraps one migration's statements as a single atomic, self-guarding, optionally advisory-locked
// block: assertMigration first (aborts the whole tx if another writer already reached `version`),
// the install DDL, then setVersion last. Same locked() shape plans.create() uses; noAdvisoryLocks
// is true for sqlite so advisoryLock is skipped there.
function flatten (c: Ctx, commands: string[], version: number, noAdvisoryLocks?: boolean): string {
  return plans.locked(
    c,
    [plans.assertMigration(c, version), ...commands, plans.setVersion(c, version)],
    undefined,
    noAdvisoryLocks
  )
}

// Selects the chain from `version` up to the newest entry and renders it as one SQL script.
export function migrate (c: Ctx, version: number, migrations?: types.Migration[], noAdvisoryLocks?: boolean): string {
  migrations = migrations || getAll(c)

  // Floor guard: refuse to climb from a DB older than the oldest entry's starting point. Without
  // it, filter(previous >= version) would select the whole chain for any version below the minimum
  // `previous` and apply migrations over missing intermediate steps. Version 0 is the from-scratch
  // sentinel and is exempt; non-numeric garbage falls through to the not-found assert below.
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
