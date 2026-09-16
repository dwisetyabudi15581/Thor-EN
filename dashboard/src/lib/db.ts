// Dashboard user database — adapts to the platform automatically.
//
// - Linux/macOS/Windows (VPS, PC): Prisma + SQLite (file db/custom.db) —
//   behavior identical to previous versions.
// - Android/Termux: the Prisma engine is a glibc binary that CANNOT be
//   loaded on Android (bionic libc) — a simple JSON store
//   (db/custom-users.json) is used instead, exposing the exact same
//   interface as every `db.user` call site in the dashboard
//   (findUnique / create / update / upsert / count), so no caller code
//   needs to change.

import path from 'node:path'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

type DbUser = {
  id: string
  discordId: string
  username: string
  globalName: string | null
  avatar: string | null
  isAdmin: boolean
  accessToken: string | null
  refreshToken: string | null
  tokenExpiresAt: Date | null
  createdAt: Date
  updatedAt: Date
}

type UserData = Partial<Omit<DbUser, 'id' | 'discordId'>> & { id?: string; discordId?: string }
type UserWhere = { id?: string; discordId?: string }

type UserDelegate = {
  findUnique(args: { where: UserWhere; select?: Partial<Record<keyof DbUser, true>> }): Promise<DbUser | null>
  create(args: { data: UserData }): Promise<DbUser>
  update(args: { where: UserWhere; data: UserData }): Promise<DbUser>
  upsert(args: { where: { discordId: string }; create: UserData; update: UserData }): Promise<DbUser>
  count(): Promise<number>
}

// The shape every dashboard call site uses: db.user.<method>
type Db = { user: UserDelegate }

const rawUrl = process.env.DATABASE_URL ?? 'file:db/custom.db'
const resolvedUrl = rawUrl.startsWith('file:') && !rawUrl.startsWith('file:/')
  ? `file:${path.resolve(process.cwd(), rawUrl.slice(5))}`
  : rawUrl

// ---------- JSON storage (Android/Termux) ----------

const DATE_FIELDS = ['tokenExpiresAt', 'createdAt', 'updatedAt'] as const

class JsonUserStore implements UserDelegate {
  private file: string
  private records: DbUser[]

  constructor(file: string) {
    this.file = file
    this.records = []
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'))
        if (Array.isArray(parsed)) this.records = parsed.map((r) => JsonUserStore.revive(r))
      } catch {
        this.records = [] // corrupted file → start empty (users just log in again)
      }
    }
  }

  private static revive(raw: Record<string, unknown>): DbUser {
    const user = { ...raw }
    for (const f of DATE_FIELDS) {
      if (typeof user[f] === 'string') user[f] = new Date(user[f] as string)
    }
    return user as unknown as DbUser
  }

  private persist() {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.records, null, 2), 'utf8')
    renameSync(tmp, this.file) // atomic: never a half-written file
  }

  private find(where: UserWhere): DbUser | undefined {
    return this.records.find(
      (u) =>
        (where.id === undefined || u.id === where.id) &&
        (where.discordId === undefined || u.discordId === where.discordId),
    )
  }

  private static defaults(data: UserData): DbUser {
    const now = new Date()
    return {
      id: data.id ?? randomUUID(),
      discordId: data.discordId ?? '',
      username: data.username ?? '',
      globalName: null,
      avatar: null,
      isAdmin: false,
      accessToken: null,
      refreshToken: null,
      tokenExpiresAt: null,
      createdAt: now,
      updatedAt: now,
      ...data,
    } as DbUser
  }

  async findUnique({ where }: { where: UserWhere }) {
    const found = this.find(where)
    return found ? { ...found } : null
  }

  async create({ data }: { data: UserData }) {
    // mimic Prisma's unique constraint (P2002) — callers handle it via try/catch
    const duplicate =
      (data.id !== undefined && this.find({ id: data.id }) !== undefined) ||
      (data.discordId !== undefined && this.find({ discordId: data.discordId }) !== undefined)
    if (duplicate) throw new Error('Unique constraint failed: user row already exists')
    const user = JsonUserStore.defaults(data)
    this.records.push(user)
    this.persist()
    return { ...user }
  }

  async update({ where, data }: { where: UserWhere; data: UserData }) {
    const found = this.find(where)
    if (!found) throw new Error('User not found') // mimics Prisma P2025
    Object.assign(found, data, { updatedAt: new Date() })
    this.persist()
    return { ...found }
  }

  async upsert(args: { where: { discordId: string }; create: UserData; update: UserData }) {
    const found = this.find(args.where)
    if (found) return this.update({ where: args.where, data: args.update })
    return this.create({ data: { ...args.create, discordId: args.where.discordId } })
  }

  async count() {
    return this.records.length
  }
}

// ---------- Platform-specific initialization ----------

const globalForDb = globalThis as unknown as { thorDb?: Db }

function createDb(): Db {
  if (process.platform === 'android') {
    // Termux: the Prisma engine cannot be loaded → JSON storage.
    // File location follows DATABASE_URL: db/custom.db → db/custom-users.json
    const jsonPath = resolvedUrl.startsWith('file:')
      ? resolvedUrl.slice(5).replace(/\.db$/i, '') + '-users.json'
      : path.resolve(process.cwd(), 'db/custom-users.json')
    console.warn(`[db] Android/Termux detected — user storage switches to JSON: ${jsonPath}`)
    return { user: new JsonUserStore(jsonPath) }
  }
  // require (not a static import) so the Prisma runtime is NEVER evaluated
  // on Android. On other platforms Prisma uses the absolute DATABASE_URL —
  // identical to the previous behavior.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PrismaClient } = require('@prisma/client')
  const prisma = new PrismaClient({
    // v3.24.1 SECURITY FIX (7.1): query logging printed SQL WITH BOUND
    // PARAMETERS — including the User row's accessToken/refreshToken (live
    // Discord OAuth tokens) — into stdout on every login/refresh. Query
    // logging is now development-only; production logs errors only.
    log: process.env.NODE_ENV === 'development' ? ['query'] : ['error'],
    datasources: { db: { url: resolvedUrl } },
  })
  // PrismaClient's `user` property is a super-set of UserDelegate — safe to cast
  return prisma as unknown as Db
}

export const db: Db = (globalForDb.thorDb ??= createDb())
