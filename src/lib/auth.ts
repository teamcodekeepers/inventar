import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, ne } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { controlDb } from "@/db/control";
import { memberships, organizations, sessions, users, type Organization, type Role, type User } from "@/db/control-schema";
import { getTenantDb, type TenantDb } from "@/db/tenant";
import { sha256 } from "./auth-crypto";
import { UserError } from "./errors";
import { can, type Level } from "./permissions";
import { APP_DOMAIN, APP_PROTOCOL, DEMO_TENANT, currentTenant, rootUrl } from "./tenant";

export { hashPassword, verifyPassword, sha256 } from "./auth-crypto";

const COOKIE = "inv_session";
const SESSION_DAYS = 30;

function cookieDomain(): string | undefined {
  const host = APP_DOMAIN.split(":")[0];
  // За localhost браузърите не приемат domain cookie; всеки поддомейн има собствена сесия.
  if (host === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return undefined;
  return `.${host}`;
}

// ------------------------------------------------------------------ sessions
export async function createSession(userId: number, organizationId: number | null) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await controlDb.insert(sessions).values({ id: sha256(token), userId, organizationId, expiresAt });
  const jar = await cookies();
  jar.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: APP_PROTOCOL === "https",
    expires: expiresAt,
    path: "/",
    domain: cookieDomain(),
  });
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) await controlDb.delete(sessions).where(eq(sessions.id, sha256(token)));
  jar.set(COOKIE, "", { maxAge: 0, path: "/", domain: cookieDomain() });
}

/** Id на текущата сесия (sha256 на cookie-то) или null. */
export async function currentSessionId() {
  const token = (await cookies()).get(COOKIE)?.value;
  return token ? sha256(token) : null;
}

/** Прекратява всички други сесии на потребителя (след смяна на парола). */
export async function destroyOtherSessions(userId: number) {
  const current = await currentSessionId();
  await controlDb.delete(sessions).where(current ? and(eq(sessions.userId, userId), ne(sessions.id, current)) : eq(sessions.userId, userId));
}

/** „Изход от всички устройства“: всички сесии, включително текущата. */
export async function destroyAllSessions(userId: number) {
  await controlDb.delete(sessions).where(eq(sessions.userId, userId));
  (await cookies()).set(COOKIE, "", { maxAge: 0, path: "/", domain: cookieDomain() });
}

export async function countSessions(userId: number) {
  const rows = await controlDb.select({ id: sessions.id }).from(sessions).where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, new Date())));
  return rows.length;
}

// ------------------------------------------------------- двуфакторна стъпка
const CHALLENGE = "inv_2fa";
const CHALLENGE_SECONDS = 300;
type Challenge = { u: number; o: number | null; exp: number };

function sign(payload: string) {
  return createHmac("sha256", `2fa:${process.env.APP_SECRET ?? ""}`).update(payload).digest("base64url");
}

/** След вярна парола при включена 2FA: подписан cookie за 5 минути вместо сесия. */
export async function startTwoFactor(userId: number, organizationId: number | null) {
  const payload = Buffer.from(JSON.stringify({ u: userId, o: organizationId, exp: Date.now() + CHALLENGE_SECONDS * 1000 } satisfies Challenge)).toString("base64url");
  (await cookies()).set(CHALLENGE, `${payload}.${sign(payload)}`, { httpOnly: true, sameSite: "lax", secure: APP_PROTOCOL === "https", maxAge: CHALLENGE_SECONDS, path: "/" });
}

export async function readTwoFactor(): Promise<Challenge | null> {
  const raw = (await cookies()).get(CHALLENGE)?.value;
  if (!raw) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const c = JSON.parse(Buffer.from(payload, "base64url").toString()) as Challenge;
  return c.exp > Date.now() ? c : null;
}

export async function clearTwoFactor() {
  (await cookies()).set(CHALLENGE, "", { maxAge: 0, path: "/" });
}

// ------------------------------------------------------------------- session
export type SessionInfo = {
  user: User;
  memberships: Array<{ organizationId: number; role: Role; organization: Organization }>;
};

/** Влезлият потребител и организациите му, независимо от поддомейна. */
export const getSession = cache(async (): Promise<SessionInfo | null> => {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (!token) return null;
  const [session] = await controlDb.select().from(sessions).where(eq(sessions.id, sha256(token))).limit(1);
  if (!session || session.expiresAt < new Date()) return null;
  const [user] = await controlDb.select().from(users).where(eq(users.id, session.userId)).limit(1);
  if (!user) return null;
  const rows = await controlDb
    .select({ organizationId: memberships.organizationId, role: memberships.role, organization: organizations })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(eq(memberships.userId, user.id));
  return { user, memberships: rows };
});

// ------------------------------------------------------------------- context
export type Context = SessionInfo & {
  org: Organization;
  role: Role;
  /** Базата на текущата организация. */
  db: TenantDb;
};

/**
 * Потребител + организация според поддомейна. null ако няма сесия, няма поддомейн,
 * или потребителят не е член на тази организация.
 */
export const getContext = cache(async (): Promise<Context | null> => {
  const [session, org] = await Promise.all([getSession(), currentTenant()]);
  if (!session || !org) return null;
  const m = session.memberships.find((x) => x.organizationId === org.id);
  if (!m) return null;
  return { ...session, org, role: m.role, db: getTenantDb(org) };
});

/** Пренасочва към вход/портал при липса на достъп; хвърля при недостатъчна роля. */
export async function requireContext(level: Level = "read"): Promise<Context> {
  const [session, org] = await Promise.all([getSession(), currentTenant()]);
  if (!org) redirect(rootUrl("/portal"));
  if (!session) redirect("/login");
  if (org.status !== "active") redirect("/provisioning");
  const m = session.memberships.find((x) => x.organizationId === org.id);
  if (!m) {
    // в демо режим порталът води обратно тук — без пренасочване
    if (DEMO_TENANT) throw new UserError(`Нямате достъп до организация „${org.name}“.`);
    redirect(rootUrl("/portal?denied=" + encodeURIComponent(org.subdomain)));
  }
  if (!can(m.role, level)) throw new UserError("Нямате права за това действие.");
  return { ...session, org, role: m.role, db: getTenantDb(org) };
}

export async function findMembership(userId: number, organizationId: number) {
  const [m] = await controlDb
    .select()
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.organizationId, organizationId)))
    .limit(1);
  return m ?? null;
}

const CYR: Record<string, string> = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sht", ъ: "a", ь: "y", ю: "yu", я: "ya" };

/** Предложение за поддомейн от име на фирма: „Демо Трейдинг ЕООД“ → demo-treyding-eood */
export function suggestSubdomain(name: string) {
  return name
    .toLowerCase()
    .split("")
    .map((c) => CYR[c] ?? c)
    .join("")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
