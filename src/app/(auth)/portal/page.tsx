import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ArrowRight, Building2, Plus } from "lucide-react";
import { AuthForm } from "@/components/auth/auth-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { createOrganization, logout } from "@/lib/actions/auth";
import { getSession } from "@/lib/auth";
import { ROLE_LABELS } from "@/lib/permissions";
import { APP_DOMAIN, APP_PROTOCOL, DEMO_TENANT, currentTenant, rootUrl, tenantUrl } from "@/lib/tenant";

export const metadata: Metadata = { title: "Портал" };

export default async function PortalPage({ searchParams }: { searchParams: Promise<{ denied?: string }> }) {
  const [session, tenant, sp] = await Promise.all([getSession(), currentTenant(), searchParams]);
  if (tenant) redirect(DEMO_TENANT ? "/" : rootUrl("/portal"));
  if (!session) redirect("/login");

  return (
    <>
      <h1 className="text-xl font-semibold">Здравейте, {session.user.name}</h1>
      <p className="mt-1 text-sm text-muted">Изберете организация. Всяка е на собствен адрес и със собствена база данни.</p>
      {sp.denied && <p className="mt-4 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">Нямате достъп до организация „{sp.denied}“. Помолете нейния администратор да ви добави.</p>}

      {session.memberships.length === 0 ? (
        <p className="mt-6 rounded-xl border border-line bg-surface-2 p-4 text-sm text-muted">Все още не сте член на организация. Създайте своя по-долу или помолете колега да ви добави.</p>
      ) : (
        <ul className="mt-6 divide-y divide-line rounded-xl border border-line">
          {session.memberships.map((m) => (
            <li key={m.organizationId}>
              <a href={tenantUrl(m.organization.subdomain)} className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-surface-2">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent-soft text-accent">
                  <Building2 className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{m.organization.name}</span>
                  <span className="block truncate font-mono text-xs text-muted">
                    {m.organization.subdomain}.{APP_DOMAIN}
                  </span>
                </span>
                <Badge tone={m.organization.status === "active" ? "neutral" : "warning"}>{m.organization.status === "active" ? ROLE_LABELS[m.role] : "подготвя се"}</Badge>
                <ArrowRight className="h-4 w-4 text-muted" />
              </a>
            </li>
          ))}
        </ul>
      )}

      {session.user.canCreateOrganizations && (
        <details className="mt-6 rounded-xl border border-line bg-surface-2/60 p-4">
          <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium">
            <Plus className="h-4 w-4" /> Нова организация
          </summary>
          <AuthForm
            action={createOrganization}
            submitLabel="Създай"
            fields={[
              { name: "name", label: "Име на фирмата", type: "text" },
              { name: "subdomain", label: "Адрес (поддомейн)", type: "text", required: false, placeholder: "moyafirma", pattern: "[a-z0-9-]{3,63}", hint: `${APP_PROTOCOL}://<поддомейн>.${APP_DOMAIN}; празно = от името.` },
            ]}
          />
        </details>
      )}

      {session.user.isPlatformAdmin && (
        <a href="/admin" className="mt-6 block rounded-xl border border-line px-4 py-3 text-center text-sm font-medium text-accent hover:bg-surface-2">
          Администрация на платформата →
        </a>
      )}
      <form action={logout} className="mt-6 text-center">
        <Button type="submit" variant="ghost" size="sm">
          Изход ({session.user.email})
        </Button>
      </form>
    </>
  );
}
