"use server";

import { and, eq, isNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import { controlDb } from "@/db/control";
import { memberships, organizations, passwordResets, plans, sessions, users } from "@/db/control-schema";
import { getTenantDb, provisionTenant, tenantDbName } from "@/db/tenant";
import { locations } from "@/db/tenant-schema";
import { clearTwoFactor, createSession, destroySession, getSession, hashPassword, readTwoFactor, startTwoFactor, suggestSubdomain, verifyPassword } from "@/lib/auth";
import { decrypt } from "@/lib/crypto";
import { consumeRecoveryCode, verifyTotp } from "@/lib/totp";
import { UserError } from "@/lib/errors";
import { str } from "@/lib/forms";
import { passwordResetMail, sendMail } from "@/lib/mail";
import { createPasswordLink, findPasswordLink, recentResetExists } from "@/lib/password-tokens";
import { clear, clientIp, hit, minutes, retryAfter } from "@/lib/rate-limit";
import { DEMO_TENANT, currentTenant, isValidSubdomain, rootUrl, tenantUrl } from "@/lib/tenant";
import { log } from "@/lib/log";
import { TRIAL_DAYS } from "@/lib/plans";
import { LEGAL_VERSION } from "@/lib/legal";

/** Вход: до 5 грешни опита за имейл и 20 за IP адрес на 15 минути. */
const loginLimits = (email: string, ip: string) => ({
  email: { key: `login:email:${email}`, max: 5, windowMs: 15 * 60_000 },
  ip: { key: `login:ip:${ip}`, max: 20, windowMs: 15 * 60_000 },
});

export async function login(_prev: string | undefined, fd: FormData): Promise<string | undefined> {
  const email = str(fd, "email").toLowerCase();
  const password = str(fd, "password");
  const limits = loginLimits(email, await clientIp());
  const wait = Math.max(await retryAfter(limits.email), await retryAfter(limits.ip));
  if (wait > 0) return `Твърде много неуспешни опити за вход. Опитайте отново след ${minutes(wait)} мин. или използвайте „Забравена парола“.`;

  const [user] = await controlDb.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    await Promise.all([hit(limits.email), hit(limits.ip)]);
    return "Грешен имейл или парола.";
  }
  await clear(limits.email.key);

  const tenant = await currentTenant();
  if (tenant) {
    const [member] = await controlDb.select().from(memberships).where(and(eq(memberships.userId, user.id), eq(memberships.organizationId, tenant.id))).limit(1);
    if (!member) return `Нямате достъп до организация „${tenant.name}“. Помолете администратора ѝ да ви добави.`;
    if (user.totpEnabledAt) {
      await startTwoFactor(user.id, tenant.id);
      redirect("/login/2fa");
    }
    await createSession(user.id, tenant.id);
    redirect("/");
  }
  if (user.totpEnabledAt) {
    await startTwoFactor(user.id, null);
    redirect("/login/2fa");
  }
  await createSession(user.id, null);
  redirect("/portal");
}

/** Втора стъпка: код от приложението или код за възстановяване. До 5 грешни опита за 15 минути. */
export async function verifyTwoFactor(_prev: string | undefined, fd: FormData): Promise<string | undefined> {
  const challenge = await readTwoFactor();
  if (!challenge) redirect("/login?expired=1");
  const limit = { key: `2fa:user:${challenge.u}`, max: 5, windowMs: 15 * 60_000 };
  const wait = await retryAfter(limit);
  if (wait > 0) return `Твърде много грешни кодове. Опитайте отново след ${minutes(wait)} мин.`;
  const [user] = await controlDb.select().from(users).where(eq(users.id, challenge.u)).limit(1);
  if (!user?.totpSecretEnc) redirect("/login");

  const code = str(fd, "code");
  const step = /^\d{6}$/.test(code.replace(/\s/g, "")) ? verifyTotp(decrypt(user.totpSecretEnc), code, user.totpLastStep) : null;
  if (step !== null) {
    await controlDb.update(users).set({ totpLastStep: step }).where(eq(users.id, user.id));
  } else {
    const rest = consumeRecoveryCode(user.totpRecoveryHashes ?? [], code);
    if (!rest) {
      await hit(limit);
      return "Невалиден код. Въведете 6-цифрения код от приложението или код за възстановяване.";
    }
    await controlDb.update(users).set({ totpRecoveryHashes: rest }).where(eq(users.id, user.id));
    log.warn("auth.recovery_code_used", { userId: user.id, left: rest.length });
  }
  await clear(limit.key);
  await clearTwoFactor();
  await createSession(user.id, challenge.o);
  redirect(challenge.o ? "/" : "/portal");
}

/** Нова организация: създава база, прилага миграциите, прави потребителя собственик. */
const DEMO_NO_NEW_ORGS = "Това е демо версия: нови организации не могат да се създават.";

async function createOrganizationFor(userId: number, name: string, subdomainInput: string) {
  const subdomain = (subdomainInput || suggestSubdomain(name)).toLowerCase();
  if (!isValidSubdomain(subdomain)) throw new UserError("Поддомейнът може да съдържа само малки латински букви, цифри и тире (3–63 знака) и да не е запазена дума.");
  const [taken] = await controlDb.select({ id: organizations.id }).from(organizations).where(eq(organizations.subdomain, subdomain)).limit(1);
  if (taken) throw new UserError(`Поддомейнът „${subdomain}“ вече е зает.`);

  // нова организация: пробен период на план „Бизнес“
  const [trialPlan] = await controlDb.select({ id: plans.id }).from(plans).where(eq(plans.code, "business"));
  const [{ id }] = await controlDb
    .insert(organizations)
    .values({ name, subdomain, dbName: tenantDbName(subdomain), planId: trialPlan?.id ?? null, subscriptionStatus: "trial", trialEndsAt: new Date(Date.now() + TRIAL_DAYS * 86_400_000) })
    .$returningId();
  await controlDb.insert(memberships).values({ userId, organizationId: id, role: "owner" });
  const [org] = await controlDb.select().from(organizations).where(eq(organizations.id, id));
  const active = await provisionTenant(org);
  await getTenantDb(active).insert(locations).values({ name: "Основен склад", code: "MAIN", isDefault: true });
  return active;
}

export async function register(_prev: string | undefined, fd: FormData): Promise<string | undefined> {
  if (DEMO_TENANT) return DEMO_NO_NEW_ORGS;
  const orgName = str(fd, "organization");
  const subdomain = str(fd, "subdomain");
  const name = str(fd, "name");
  const email = str(fd, "email").toLowerCase();
  const password = str(fd, "password");
  if (!orgName || !name || !email) return "Попълнете всички полета.";
  if (password.length < 8) return "Паролата трябва да е поне 8 знака.";
  if (fd.get("acceptTerms") !== "on") return "Приемете Общите условия и Политиката за поверителност.";
  const [existing] = await controlDb.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing) return "Вече има акаунт с този имейл. Влезте и създайте организацията от портала.";

  let org;
  try {
    const [{ id: userId }] = await controlDb.insert(users).values({ email, name, passwordHash: hashPassword(password), termsVersion: LEGAL_VERSION, termsAcceptedAt: new Date() }).$returningId();
    org = await createOrganizationFor(userId, orgName, subdomain);
    await createSession(userId, org.id);
  } catch (e) {
    if (e instanceof UserError) return e.message;
    log.error("register.create_organization_failed", e);
    return "Грешка при създаване на организацията. Опитайте отново.";
  }
  redirect(tenantUrl(org.subdomain, "/onboarding"));
}

/** От портала: влязъл потребител създава още една организация. */
export async function createOrganization(_prev: string | undefined, fd: FormData): Promise<string | undefined> {
  const session = await getSession();
  if (!session) redirect("/login");
  if (DEMO_TENANT) return DEMO_NO_NEW_ORGS;
  if (!session.user.canCreateOrganizations) return "Нямате право да създавате организации.";
  const name = str(fd, "name");
  if (!name) return "Въведете име на организацията.";
  let org;
  try {
    org = await createOrganizationFor(session.user.id, name, str(fd, "subdomain"));
  } catch (e) {
    if (e instanceof UserError) return e.message;
    log.error("register.create_organization_failed", e);
    return "Грешка при създаване на организацията. Опитайте отново.";
  }
  redirect(tenantUrl(org.subdomain, "/onboarding"));
}

/** Забравена парола: изпраща линк, ако има такъв акаунт. Отговорът е еднакъв и без акаунт. */
export async function requestPasswordReset(_prev: string | undefined, fd: FormData): Promise<string | undefined> {
  const email = str(fd, "email").toLowerCase();
  if (!email) return "Въведете имейл.";
  const ipLimit = { key: `reset:ip:${await clientIp()}`, max: 10, windowMs: 60 * 60_000 };
  const wait = await retryAfter(ipLimit);
  if (wait > 0) return `Твърде много заявки. Опитайте отново след ${minutes(wait)} мин.`;
  await hit(ipLimit);
  const tenant = await currentTenant();
  const [user] = await controlDb.select().from(users).where(eq(users.email, email)).limit(1);
  if (user && !(await recentResetExists(user.id))) {
    const member = tenant && (await controlDb.select().from(memberships).where(and(eq(memberships.userId, user.id), eq(memberships.organizationId, tenant.id))).limit(1)).length > 0;
    const org = member ? tenant : null;
    const url = await createPasswordLink(user, "reset", org);
    try {
      await sendMail(passwordResetMail({ to: user.email, name: user.name, url, orgName: org?.name }));
    } catch (e) {
      log.error("mail.password_reset_failed", e);
      return "Писмото не можа да бъде изпратено. Опитайте отново по-късно.";
    }
  }
  redirect("/forgot-password?sent=1");
}

/** Нова парола по линк (забравена парола или покана). Прекратява всички сесии на потребителя. */
export async function resetPassword(_prev: string | undefined, fd: FormData): Promise<string | undefined> {
  const password = str(fd, "password");
  if (password.length < 8) return "Паролата трябва да е поне 8 знака.";
  if (password !== str(fd, "confirm")) return "Паролите не съвпадат.";
  const found = await findPasswordLink(str(fd, "token"));
  if (!found) return "Линкът е невалиден или е изтекъл. Заявете нов.";
  const { link, user, organization } = found;

  // Еднократен: маркира се като използван само ако още не е бил (паралелни заявки).
  const [res] = await controlDb.update(passwordResets).set({ usedAt: new Date() }).where(and(eq(passwordResets.id, link.id), isNull(passwordResets.usedAt)));
  if (res.affectedRows !== 1) return "Линкът вече е използван.";
  await controlDb.update(users).set({ passwordHash: hashPassword(password) }).where(eq(users.id, user.id));
  await controlDb.delete(sessions).where(eq(sessions.userId, user.id));
  await controlDb.delete(passwordResets).where(and(eq(passwordResets.userId, user.id), isNull(passwordResets.usedAt)));

  // с двуфакторна защита новата парола не е достатъчна за вход: нормален вход с код
  if (user.totpEnabledAt) redirect("/login?reset=1");
  const tenant = await currentTenant();
  const org = tenant && organization?.id === tenant.id ? tenant : null;
  await createSession(user.id, org?.id ?? null);
  redirect(org ? "/" : "/portal");
}

export async function logout() {
  await destroySession();
  redirect(rootUrl("/login"));
}
