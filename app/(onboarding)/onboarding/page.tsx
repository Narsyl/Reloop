import Link from "next/link";
import Image from "next/image";
import relooplogo from "@/app/relooplogo-trimmed.png";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { listMemberships } from "@/lib/auth/tenancy";
import { createOrganizationAndContinue } from "@/lib/domain/organizations/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const TIMEZONES = ["Europe/London", "Europe/Dublin", "Europe/Paris", "Europe/Berlin", "America/New_York", "America/Chicago", "America/Los_Angeles", "Australia/Sydney"];
const CURRENCIES = ["GBP", "EUR", "USD", "AUD", "CAD"];

export default async function OnboardingPage({ searchParams }: PageProps<"/onboarding">) {
  const session = await requireUser();
  const params = await searchParams;
  const memberships = await listMemberships();
  const creatingAnother = params.new === "1";
  if (memberships.length > 0 && !creatingAnother) redirect("/overview");
  const error = typeof params.error === "string" ? params.error : null;

  return (
    <div className="flex min-h-screen flex-col bg-surface">
      <header className="flex h-14 items-center justify-between px-6">
        <span className="flex items-center">
          <Image src={relooplogo} alt="Reloop" className="h-7 w-auto object-contain" priority />
        </span>
        <span className="text-xs text-muted-foreground">{session.user.email}</span>
      </header>
      <main className="flex flex-1 items-start justify-center px-4 py-12 sm:items-center sm:py-0">
        <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-sm">
          <div className="mb-6 space-y-1">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Step 1 of 2</p>
            <h1 className="text-lg font-semibold tracking-tight">{creatingAnother ? "Create another organisation" : "Set up your organisation"}</h1>
            <p className="text-sm text-muted-foreground">
              An organisation is your business workspace. Subscriptions, reward journeys and history all belong to it. You can connect your subscription platform once it exists.
            </p>
          </div>
          <form action={createOrganizationAndContinue} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="name">Organisation name</Label>
              <Input id="name" name="name" placeholder="e.g. Ancient Extracts" required minLength={2} autoFocus />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="timezone">Timezone</Label>
                <select
                  id="timezone"
                  name="timezone"
                  defaultValue="Europe/London"
                  className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {TIMEZONES.map((tz) => (
                    <option key={tz} value={tz}>{tz}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="currency">Currency</Label>
                <select
                  id="currency"
                  name="currency"
                  defaultValue="GBP"
                  className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {CURRENCIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">Timezone drives when markers are attached relative to each charge date; both can be changed later in Settings.</p>
            {error && (
              <p role="alert" className="rounded-md bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{error}</p>
            )}
            <div className="flex items-center justify-between gap-3 pt-1">
              {creatingAnother ? (
                <Button variant="ghost" render={<Link href="/overview" />}>Cancel</Button>
              ) : <span />}
              <Button type="submit">Create organisation</Button>
            </div>
          </form>
        </div>
      </main>
    </div>
  );
}
