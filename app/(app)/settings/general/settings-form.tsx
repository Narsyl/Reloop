"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { updateOrganizationSettings } from "@/lib/domain/organizations/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionHeader } from "@/components/layout/page-header";

const TIMEZONES = ["Europe/London", "Europe/Dublin", "Europe/Paris", "Europe/Berlin", "Europe/Amsterdam", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Australia/Sydney", "Asia/Singapore"];
const CURRENCIES = ["GBP", "EUR", "USD", "AUD", "CAD", "NZD"];

type Values = { name: string; timezone: string; currency: string; markerLeadHours: number };

export function SettingsForm({ initial, slug, canEdit }: { initial: Values; slug: string; canEdit: boolean }) {
  const [values, setValues] = useState<Values>(initial);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [pending, start] = useTransition();
  const dirty = JSON.stringify(values) !== JSON.stringify(initial);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    start(async () => {
      const res = await updateOrganizationSettings(values);
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {});
        toast.error(res.error);
        return;
      }
      setErrors({});
      toast.success("Settings saved");
    });
  }

  const selectCls = "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50";

  return (
    <form onSubmit={submit} className="space-y-8">
      <section className="space-y-4 rounded-xl border border-border bg-card p-5">
        <SectionHeader title="Organisation" description="How your workspace is identified." />
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="name">Name</Label>
            <Input id="name" value={values.name} disabled={!canEdit} onChange={(e) => setValues({ ...values, name: e.target.value })} />
            {errors.name && <p className="text-xs text-status-danger">{errors.name[0]}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="slug">Slug</Label>
            <Input id="slug" value={slug} disabled readOnly className="font-mono" />
            <p className="text-xs text-muted-foreground">Used internally; not editable yet.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="timezone">Timezone</Label>
            <select id="timezone" className={selectCls} value={values.timezone} disabled={!canEdit} onChange={(e) => setValues({ ...values, timezone: e.target.value })}>
              {[...new Set([values.timezone, ...TIMEZONES])].map((tz) => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">Charge dates from your platform are interpreted in this timezone.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="currency">Currency</Label>
            <select id="currency" className={selectCls} value={values.currency} disabled={!canEdit} onChange={(e) => setValues({ ...values, currency: e.target.value })}>
              {[...new Set([values.currency, ...CURRENCIES])].map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
        </div>
      </section>

      <section className="space-y-4 rounded-xl border border-border bg-card p-5">
        <SectionHeader title="Operational preferences" description="How far ahead of a charge the platform attaches a planned fulfilment marker." />
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="lead">Marker lead time (hours)</Label>
            <Input
              id="lead"
              type="number"
              min={1}
              max={24 * 14}
              className="tnum"
              value={values.markerLeadHours}
              disabled={!canEdit}
              onChange={(e) => setValues({ ...values, markerLeadHours: Number(e.target.value) })}
            />
            {errors.markerLeadHours && <p className="text-xs text-status-danger">{errors.markerLeadHours[0]}</p>}
            <p className="text-xs text-muted-foreground">
              Default 72 hours (3 days). Markers are planned immediately after the previous delivery, but only written to the subscription platform this many hours before the target charge date. Shorter keeps the upcoming order quiet for longer; longer gives more time to catch problems.
            </p>
          </div>
        </div>
      </section>

      {canEdit ? (
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={pending || !dirty}>{pending ? "Saving…" : "Save changes"}</Button>
          {dirty && (
            <Button type="button" variant="ghost" onClick={() => setValues(initial)} disabled={pending}>
              Discard
            </Button>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">You need the Admin or Owner role to change settings.</p>
      )}
    </form>
  );
}
