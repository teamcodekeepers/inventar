import "server-only";
import { count, desc, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { controlDb } from "@/db/control";
import { databasePool, memberships, organizations, sessions, users } from "@/db/control-schema";
import { getSession } from "./auth";
import { UserError } from "./errors";
import { DEMO_TENANT, currentTenant, rootUrl } from "./tenant";

/** /admin: само на основния домейн и само за администратори на платформата (иначе 404). */
export async function requirePlatformAdmin() {
  const [session, tenant] = await Promise.all([getSession(), currentTenant()]);
  if (tenant) redirect(DEMO_TENANT ? "/" : rootUrl("/admin"));
  if (!session) redirect("/login");
  if (!session.user.isPlatformAdmin) notFound();
  return session;
}

/** Същото за server actions: грешка вместо пренасочване. */
export async function assertPlatformAdmin() {
  const [session, tenant] = await Promise.all([getSession(), currentTenant()]);
  if (tenant || !session?.user.isPlatformAdmin) throw new UserError("Нямате права за това действие.");
  return session;
}

export async function listOrganizationsWithStats() {
  const pool = controlDb.select({ orgId: databasePool.assignedOrganizationId, host: databasePool.dbHost }).from(databasePool).where(isNotNull(databasePool.assignedOrganizationId)).as("pool");
  return controlDb
    .select({
      org: organizations,
      members: sql<number>`(select count(*) from ${memberships} where ${memberships.organizationId} = ${organizations.id})`.mapWith(Number),
      owner: sql<string | null>`(select ${users.email} from ${memberships} join ${users} on ${users.id} = ${memberships.userId} where ${memberships.organizationId} = ${organizations.id} and ${memberships.role} = 'owner' order by ${memberships.id} limit 1)`,
      poolHost: pool.host,
    })
    .from(organizations)
    .leftJoin(pool, eq(pool.orgId, organizations.id))
    .orderBy(desc(organizations.createdAt));
}

export async function platformStats() {
  const [byStatus, [userCount], [adminCount], [activeSessions], [poolFree], [poolUsed]] = await Promise.all([
    controlDb.select({ status: organizations.status, n: count() }).from(organizations).groupBy(organizations.status),
    controlDb.select({ n: count() }).from(users),
    controlDb.select({ n: count() }).from(users).where(eq(users.isPlatformAdmin, true)),
    controlDb.select({ n: count() }).from(sessions).where(gt(sessions.expiresAt, new Date())),
    controlDb.select({ n: count() }).from(databasePool).where(isNull(databasePool.assignedOrganizationId)),
    controlDb.select({ n: count() }).from(databasePool).where(isNotNull(databasePool.assignedOrganizationId)),
  ]);
  const status = Object.fromEntries(byStatus.map((r) => [r.status, r.n])) as Partial<Record<(typeof organizations.$inferSelect)["status"], number>>;
  return {
    organizations: byStatus.reduce((a, r) => a + r.n, 0),
    status,
    users: userCount.n,
    platformAdmins: adminCount.n,
    activeSessions: activeSessions.n,
    pool: { free: poolFree.n, assigned: poolUsed.n },
  };
}

export async function listPool() {
  return controlDb
    .select({ entry: databasePool, org: { id: organizations.id, name: organizations.name, subdomain: organizations.subdomain } })
    .from(databasePool)
    .leftJoin(organizations, eq(organizations.id, databasePool.assignedOrganizationId))
    .orderBy(databasePool.assignedOrganizationId, databasePool.dbName);
}
