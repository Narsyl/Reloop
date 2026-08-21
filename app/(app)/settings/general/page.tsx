import { hasRole, requireOrg } from "@/lib/auth/tenancy";
import { getOrganizationSettings } from "@/lib/domain/queries/settings";
import { SettingsForm } from "./settings-form";

export const metadata = { title: "General settings" };

export default async function GeneralSettingsPage() {
  const ctx = await requireOrg();
  const org = await getOrganizationSettings(ctx);
  return (
    <div className="max-w-2xl space-y-6">
      <SettingsForm
        initial={{ name: org.name, timezone: org.timezone, currency: org.currency, markerLeadHours: org.markerLeadHours }}
        slug={org.slug}
        canEdit={hasRole(ctx, "ADMIN")}
      />
    </div>
  );
}
