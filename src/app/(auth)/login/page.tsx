import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth/auth-form";
import { getSession } from "@/lib/auth";
import { login } from "@/lib/actions/auth";
import { DEMO_TENANT, currentTenant, rootUrl } from "@/lib/tenant";

export const metadata: Metadata = { title: "Вход" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ reset?: string; expired?: string }> }) {
  const [session, tenant, sp] = await Promise.all([getSession(), currentTenant(), searchParams]);
  if (session) redirect(tenant ? "/" : "/portal");
  return (
    <>
      <h1 className="text-xl font-semibold">Вход</h1>
      <p className="mt-1 text-sm text-muted">{tenant ? <>Организация: <strong>{tenant.name}</strong></> : "Влезте с имейл и парола. След това избирате организация."}</p>
      {sp.reset && <p className="mt-4 rounded-lg bg-success-soft px-3 py-2 text-sm text-success">Паролата е сменена. Влезте с новата парола и кода от приложението.</p>}
      {sp.expired && <p className="mt-4 rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">Времето за въвеждане на кода изтече. Влезте отново.</p>}
      <AuthForm
        action={login}
        submitLabel="Вход"
        fields={[
          { name: "email", label: "Имейл", type: "email", autoComplete: "email" },
          { name: "password", label: "Парола", type: "password", autoComplete: "current-password" },
        ]}
      >
        <div className="-mt-2 text-right text-sm">
          <Link href="/forgot-password" className="text-accent hover:underline">
            Забравена парола?
          </Link>
        </div>
      </AuthForm>
      {!DEMO_TENANT && (
        <p className="mt-6 text-center text-sm text-muted">
          Нямате акаунт?{" "}
          <Link href={tenant ? rootUrl("/register") : "/register"} className="font-medium text-accent hover:underline">
            Създайте организация
          </Link>
        </p>
      )}
    </>
  );
}
