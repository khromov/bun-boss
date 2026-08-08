import assert from 'node:assert'
import * as plans from './plans.ts'
import * as migrationStore from './migrationStore.ts'
import packageJson from '../package.json' with { type: 'json' }
import type * as types from './types.ts'

const schemaVersion = packageJson.bunboss.schema as number

// A name postgres would store unchanged if written without quotes.
const BARE_LOWER_IDENTIFIER_REGEX = /^[a-z_][a-z0-9_]*$/

class Contractor {
  static constructionPlans (schema = plans.DEFAULT_SCHEMA, options = { createSchema: true }) {
    return plans.create(schema, schemaVersion, options)
  }

  private config: types.ResolvedConstructorOptions
  private db: types.IDatabase
  private migrations: types.Migration[]

  constructor (db: types.IDatabase, config: types.ResolvedConstructorOptions) {
    this.config = config
    this.db = db
    this.migrations = config.__test__migrations ?? migrationStore.getAll(config, {
      noTablePartitioning: config.noTablePartitioning,
      noCoveringIndexes: config.noCoveringIndexes
    })
  }

  async schemaVersion () {
    const result = await this.db.executeSql(plans.getVersion(this.config))
    return result.rows.length ? parseInt(result.rows[0].version) : null
  }

  async isInstalled () {
    const result = await this.db.executeSql(plans.versionTableExists(this.config))
    return !!result.rows[0].name
  }

  async start () {
    const installed = await this.isInstalled()

    if (installed) {
      const version = await this.schemaVersion()

      if (version !== null && schemaVersion > version) {
        await this.migrate(version)
      }
    } else {
      await this.assertNoSchemaCaseVariant()
      await this.create()
    }
  }

  // `schema: 'MySchema'` and `schema: '"MySchema"'` are two different schemas - postgres folds the
  // bare form to `myschema` and stores the quoted one verbatim - but the two configs differ by two
  // characters and are indistinguishable in logs. Getting it wrong is not an error on its own: the
  // version table simply isn't there, so bun-boss installs a second, empty schema alongside the
  // populated one and every existing job silently disappears. Fires only on the install path, and
  // only when the variant actually holds a bun-boss install, so an unrelated schema that happens to
  // share a folded name never blocks a legitimate install.
  private async assertNoSchemaCaseVariant () {
    if (this.config.allowSchemaCaseVariant) {
      return
    }

    const schema = this.config.schema
    let variants: string[]

    try {
      const result = await this.db.executeSql(plans.getSchemaCaseVariants(schema))
      variants = result.rows.map((r: { name: string }) => r.name)
    } catch {
      // Catalog access varies across backends and permission setups. A probe that cannot run is
      // not evidence of a problem, so it must never block an install that would otherwise succeed.
      return
    }

    if (variants.length === 0) {
      return
    }

    // A variant that is already a legal lower-case bare identifier is reached by writing it bare;
    // anything else (mixed case, or a name needing quotes) has to be configured quoted.
    const spellings = variants.map(name => BARE_LOWER_IDENTIFIER_REGEX.test(name) ? `'${name}'` : `'"${name}"'`)

    throw new Error(`bun-boss is not installed in schema ${schema}, but is installed in ${variants.map(n => `"${n}"`).join(', ')}, which differs only in case. ` +
      'PostgreSQL folds unquoted names to lower case and stores quoted names verbatim, so these are different schemas. ' +
      `To use the existing installation, set schema: ${spellings.join(' or ')}. ` +
      'To install a new schema beside it anyway, set allowSchemaCaseVariant: true.')
  }

  async check () {
    const installed = await this.isInstalled()

    if (!installed) {
      throw new Error('bun-boss is not installed')
    }

    const version = await this.schemaVersion()

    if (schemaVersion !== version) {
      throw new Error(`bun-boss schema version ${version} does not match the expected version ${schemaVersion}`)
    }
  }

  async migrate (version: number) {
    try {
      const commands = migrationStore.migrate(this.config, version, this.migrations, this.config.noAdvisoryLocks)
      await this.db.executeSql(commands)
    } catch (err: any) {
      // A concurrent migrator that reached the target first makes assertMigration abort the whole
      // transaction: division by zero (22012) on postgres, a version-PK violation (23505) on
      // sqlite. Both are benign race losers; anything else rethrows. Mirrors create()'s tolerance.
      const benignRace = err.code === plans.PG_ERROR.divisionByZero || err.code === '23505'
      assert(benignRace, err)
    }
  }

  async create () {
    try {
      const commands = plans.create(this.config, schemaVersion, this.config)
      await this.db.executeSql(commands)
    } catch (err: any) {
      // A tight CREATE SCHEMA IF NOT EXISTS race surfaces as a duplicate pg_namespace key whose
      // message lacks 'already exists' (only the detail carries it), so match that flavor too.
      const benignRace = err.message.includes(plans.CREATE_RACE_MESSAGE) ||
        (err.code === '23505' && err.constraint === 'pg_namespace_nspname_index')
      assert(benignRace, err)
    }
  }
}

export default Contractor
