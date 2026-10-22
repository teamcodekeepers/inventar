import "server-only";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { cache } from "react";
import { controlDb } from "@/db/control";
import { organizations, type Organization } from "@/db/control-schema";

export const APP_DOMAIN = (process.env.APP_DOMAIN ?? "localhost:3000").toLowerCase();
export const APP_PROTOCOL = process.env.APP_PROTOCOL ?? (APP_DOMAIN.startsWith("localhost") ? "http" : "https");
/**
 * Демо режим (DEMO_TENANT=<поддомейн>): целият сайт е тази една организация, без поддомейни — за хостинг,
 * който не може да приема *.APP_DOMAIN. Порталът, регистрацията и /admin не се ползват.
 */
export const DEMO_TENANT = process.env.DEMO_TENANT?.trim().toLowerCase() || null;
const RESERVED = new Set(["www", "app", "api", "admin", "docs", "static", "mail", "ftp", "cpanel", "login"]);

/** Връща поддомейна от host заглавието или null за основния домейн. */
export function subdomainFromHost(host: string | null): string | null {
  if (DEMO_TENANT) return DEMO_TENANT;
  if (!host) return null;
  const h = host.toLowerCase();
  if (h === APP_DOMAIN || h === `www.${APP_DOMAIN}`) return null;
  if (!h.endsWith(`.${APP_DOMAIN}`)) return null;
  const sub = h.slice(0, -(APP_DOMAIN.length + 1));
  if (!sub || sub.includes(".")) return null;
  return sub;
}

export function isValidSubdomain(s: string) {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s) && !RESERVED.has(s);
}

export function tenantUrl(subdomain: string, pathname = "/") {
  if (DEMO_TENANT) return rootUrl(pathname);
  return `${APP_PROTOCOL}://${subdomain}.${APP_DOMAIN}${pathname}`;
}

export function rootUrl(pathname = "/") {
  return `${APP_PROTOCOL}://${APP_DOMAIN}${pathname}`;
}

export async function currentHost() {
  const h = await headers();
  return h.get("x-forwarded-host") ?? h.get("host");
}

export const getOrganizationBySubdomain = cache(async (subdomain: string): Promise<Organization | null> => {
  const [org] = await controlDb.select().from(organizations).where(eq(organizations.subdomain, subdomain)).limit(1);
  return org ?? null;
});

/** Организацията според поддомейна на текущата заявка (null на основния домейн или непознат поддомейн). */
export const currentTenant = cache(async (): Promise<Organization | null> => {
  const sub = subdomainFromHost(await currentHost());
  return sub ? getOrganizationBySubdomain(sub) : null;
});

export function tenantFromRequest(req: Request) {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const sub = subdomainFromHost(host);
  return sub ? getOrganizationBySubdomain(sub) : Promise.resolve(null);
}
