// SQLite database (Prisma). Relative file: paths are resolved against
// the dashboard/ folder (the CWD when the server runs) so the prisma CLI
// (db push) and the runtime client ALWAYS point at the same file, wherever
// the standalone build is placed.

import { PrismaClient } from '@prisma/client'
import path from 'node:path'

const rawUrl = process.env.DATABASE_URL ?? 'file:db/custom.db'
const resolvedUrl = rawUrl.startsWith('file:') && !rawUrl.startsWith('file:/')
  ? `file:${path.resolve(process.cwd(), rawUrl.slice(5))}`
  : rawUrl

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['query'],
    datasources: { db: { url: resolvedUrl } },
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
