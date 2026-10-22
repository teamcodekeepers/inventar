import { and, eq, isNull, sql } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import mysql from "mysql2/promise";
import path from "node:path";
import { decrypt, encrypt } from "@/lib/crypto";
import { controlDb, utcSessions } from "./control";
import { databasePool, organizations, type Organization } from "./control-schema";
import * as schema from "./tenant-schema";

export type TenantDb = MySql2Database<typeof schema>;
/** Или базата, или транзакция върху нея. */
export type TenantTx = Parameters<Parameters<TenantDb["transaction"]>[0]>[0];
export type Db = TenantDb | TenantTx;

const MIGRATIONS = path.join(process.cwd(), "drizzle", "tenant");

// ------------------------------------------------------------ connection info
type Conn = { host: string; port: number; user: string; password: string; database: string };

function adminConn(): Omit<Conn, "database"> {
  const u = new URL(process.env.TENANT_DB_ADMIN_URL ?? "mysql://root:root@localhost:3307");
  return { host: u.hostname, port: Number(u.port || 3306), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
}

export function connFor(org: Pick<Organization, "dbName" | "dbHost" | "dbPort" | "dbUser" | "dbPasswordEnc">): Conn {
  if (org.dbHost && org.dbUser) {
    return { host: org.dbHost, port: org.dbPort ?? 3306, user: org.dbUser, password: org.dbPasswordEnc ? decrypt(org.dbPasswordEnc) : "", database: org.dbName };
  }
  return { ...adminConn(), database: org.dbName };
}

// ------------------------------------------------------------------ pool cache
type Entry = { pool: mysql.Pool; db: TenantDb; lastUsed: number };
const g = globalThis as unknown as { __tenantPools?: Map<string, Entry> };
const cache: Map<string, Entry> = g.__tenantPools ?? new Map();
g.__tenantPools = cache; // общ за процеса, както пула на контролната база
const MAX_POOLS = 50;

function open(conn: Conn, limit = 5): Entry {
  const pool = mysql.createPool({ ...conn, connectionLimit: limit, timezone: "Z", charset: "utf8mb4_0900_ai_ci", supportBigNumbers: true });
  utcSessions(pool);
  // без LATERAL — виж control.ts
  return { pool, db: drizzle(pool, { schema, mode: "planetscale" }), lastUsed: Date.now() };
}

/** Връзка към базата на организацията (кеширана; най-старите се затварят при лимит). */
export function getTenantDb(org: Organization): TenantDb {
  const conn = connFor(org);
  const key = `${conn.host}:${conn.port}/${conn.database}`;
  let entry = cache.get(key);
  if (!entry) {
    if (cache.size >= MAX_POOLS) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (oldest) {
        void oldest[1].pool.end();
        cache.delete(oldest[0]);
      }
    }
    entry = open(conn);
    cache.set(key, entry);
  }
  entry.lastUsed = Date.now();
  return entry.db;
}

/** Брой отворени пулове към клиентски бази (за /api/health). */
export const tenantPoolCount = () => cache.size;

/** Затваря всички кеширани връзки (тестове, спиране на процеса). */
export async function closeTenantPools() {
  await Promise.all([...cache.values()].map((e) => e.pool.end()));
  cache.clear();
}

// ---------------------------------------------------------------- provisioning
export function tenantDbName(subdomain: string) {
  const prefix = process.env.TENANT_DB_PREFIX ?? "inv_";
  return `${prefix}${subdomain.replace(/[^a-z0-9_]/g, "_")}`.slice(0, 64);
}

/** Прилага миграциите от drizzle/tenant към една клиентска база. */
export async function migrateTenantDb(db: TenantDb) {
  await migrate(db, { migrationsFolder: MIGRATIONS });
}

/**
 * Създава (или взема от пула) база за нова организация, прилага миграциите и записва
 * връзката в контролната база. Връща обновената организация.
 */
export async function provisionTenant(org: Organization): Promise<Organization> {
  const mode = process.env.TENANT_DB_MODE ?? "auto";
  let patch: Partial<Organization> = {};

  if (mode === "manual") {
    const [free] = await controlDb.select().from(databasePool).where(isNull(databasePool.assignedOrganizationId)).limit(1);
    if (!free) throw new Error("Няма свободна база в пула. Добавете с: pnpm db:pool:add <база> <потребител> <парола> [host] [port]");
    await controlDb.update(databasePool).set({ assignedOrganizationId: org.id }).where(and(eq(databasePool.id, free.id), isNull(databasePool.assignedOrganizationId)));
    patch = { dbName: free.dbName, dbHost: free.dbHost, dbPort: free.dbPort, dbUser: free.dbUser, dbPasswordEnc: free.dbPasswordEnc };
  } else {
    const name = org.dbName || tenantDbName(org.subdomain);
    const admin = mysql.createPool({ ...adminConn(), connectionLimit: 1 });
    try {
      await admin.query(`CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    } finally {
      await admin.end();
    }
    patch = { dbName: name, dbHost: null, dbPort: null, dbUser: null, dbPasswordEnc: null };
  }

  const updated: Organization = { ...org, ...patch };
  try {
    await migrateTenantDb(getTenantDb(updated));
    await controlDb.update(organizations).set({ ...patch, status: "active" }).where(eq(organizations.id, org.id));
    return { ...updated, status: "active" };
  } catch (e) {
    await controlDb.update(organizations).set({ ...patch, status: "failed" }).where(eq(organizations.id, org.id));
    throw e;
  }
}

/** Добавя предварително създадена база в пула (режим manual). */
export async function addDatabaseToPool(input: { dbName: string; dbUser: string; dbPassword: string; dbHost?: string; dbPort?: number }) {
  await controlDb.insert(databasePool).values({
    dbName: input.dbName,
    dbUser: input.dbUser,
    dbPasswordEnc: encrypt(input.dbPassword),
    dbHost: input.dbHost ?? "localhost",
    dbPort: input.dbPort ?? 3306,
  });
}

/** Изтрива базата на организация (само режим auto). Използва се от seed/reset. */
export async function dropTenantDatabase(dbName: string) {
  const admin = mysql.createPool({ ...adminConn(), connectionLimit: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
  } finally {
    await admin.end();
  }
}

export { sql };
