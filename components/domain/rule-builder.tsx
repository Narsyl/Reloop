"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import type { EligibilityScope, RuleStatus } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ImpactPanel } from "@/components/domain/impact-panel";
import { previewMilestoneImpact, saveRule, setRuleStatus } from "@/lib/domain/rules/actions";
import type { ImpactSummary } from "@/lib/domain/rules/impact";
import { CYCLE_ONE_EXPLANATION, MIN_RULE_CYCLE, validateRuleConfig } from "@/lib/domain/rules/validation";
import { ruleSentence } from "@/components/domain/rule-summary";
import { eligibilityScopeLabel } from "@/lib/status";
import { cn } from "@/lib/utils";

export type BuilderOptions = {
  programs: { id: string; name: string; description: string | null; _count: { products: number } }[];
  markers: { id: string; name: string; title: string | null; sku: string | null; externalVariantId: string; integrationId: string; integration: { displayName: string } }[];
  existing: { id: string; programId: string; cycleNumber: number; name: string; status: RuleStatus }[];
};

export type BuilderInitial = {
  id?: string;
  name: string;
  description: string;
  programId: string;
  cycleNumber: number;
  fulfillmentMarkerId: string;
  eligibilityScope: EligibilityScope | null;
  status?: RuleStatus;
};

const selectCls = "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50";

export function RuleBuilder({ options, initial, canManage }: { options: BuilderOptions; initial?: BuilderInitial; canManage: boolean }) {
  const router = useRouter();
  const [form, setForm] = useState<BuilderInitial>(initial ?? { name: "", description: "", programId: options.programs[0]?.id ?? "", cycleNumber: 2, fulfillmentMarkerId: options.markers[0]?.id ?? "", eligibilityScope: null });
  const [impact, setImpact] = useState<ImpactSummary | null>(null);
  const [impactError, setImpactError] = useState<string | null>(null);
  const [loadingImpact, startImpact] = useTransition();
  const [saving, startSave] = useTransition();
  const [serverErrors, setServerErrors] = useState<Record<string, string[]>>({});

  const program = options.programs.find((p) => p.id === form.programId);
  const marker = options.markers.find((m) => m.id === form.fulfillmentMarkerId);
  const defaultNameEarly = program && marker && Number.isInteger(form.cycleNumber) ? `${program.name} · delivery ${form.cycleNumber} → ${marker.name}` : "";
  const issues = validateRuleConfig({ name: form.name.trim() || defaultNameEarly, programId: form.programId || null, cycleNumber: Number.isFinite(form.cycleNumber) ? form.cycleNumber : null, fulfillmentMarkerId: form.fulfillmentMarkerId || null, eligibilityScope: form.eligibilityScope });
  const issueFor = (field: string) => serverErrors[field]?.[0] ?? issues.find((i) => i.field === field)?.message;
  const milestoneTaken = options.existing.find((e) => e.programId === form.programId && e.cycleNumber === form.cycleNumber && e.id !== form.id);
  const cycleOk = Number.isInteger(form.cycleNumber) && form.cycleNumber >= MIN_RULE_CYCLE;

  // live impact whenever programme/cycle change (debounced lightly); the fetch is async,
  // so state updates happen in the callback, not synchronously in the effect body
  const impactApplicable = !!form.programId && cycleOk;
  useEffect(() => {
    if (!impactApplicable) return;
    const { programId, cycleNumber, fulfillmentMarkerId } = form;
    const t = setTimeout(() => {
      startImpact(async () => {
        const res = await previewMilestoneImpact({ programId, cycleNumber, fulfillmentMarkerId: fulfillmentMarkerId || null });
        if (res.ok) {
          setImpact(res.data!);
          setImpactError(null);
        } else {
          setImpact(null);
          setImpactError(res.error);
        }
      });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [impactApplicable, form.programId, form.cycleNumber, form.fulfillmentMarkerId]);

  // derived default name (no effect needed)
  const defaultName = program && marker && cycleOk ? `${program.name} · delivery ${form.cycleNumber} → ${marker.name}` : "";
  const effectiveName = form.name.trim() || defaultName;

  function save(thenReady: boolean) {
    setServerErrors({});
    startSave(async () => {
      const res = await saveRule({ ...form, name: effectiveName, description: form.description });
      if (!res.ok) {
        setServerErrors(res.fieldErrors ?? {});
        toast.error(res.error);
        return;
      }
      const id = res.data!.id;
      if (thenReady) {
        const r2 = await setRuleStatus({ id, status: "READY" });
        if (!r2.ok) {
          toast.error(r2.error);
          router.push(`/rules/${id}`);
          router.refresh();
          return;
        }
        toast.success("Rule saved and marked Ready (no actions are planned until the automation engine is enabled)");
      } else toast.success("Rule saved as draft");
      router.push(`/rules/${id}`);
      router.refresh();
    });
  }

  const readyBlockers = issues.filter((i) => i.blocksReady);
  const canSaveDraft = canManage && effectiveName.trim().length >= 2 && !!form.programId && !!form.fulfillmentMarkerId && cycleOk && !milestoneTaken;
  const canReady = canSaveDraft && readyBlockers.length === 0;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      <div className="space-y-5">
        <section className="space-y-4 rounded-xl border border-border bg-card p-5">
          <div>
            <div className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Step 1 · Which subscription programme?</div>
            <select className={cn(selectCls, "mt-2")} value={form.programId} onChange={(e) => setForm({ ...form, programId: e.target.value })} disabled={!canManage}>
              {options.programs.length === 0 && <option value="">No programmes yet — create one on Products</option>}
              {options.programs.map((p) => (
                <option key={p.id} value={p.id}>{p.name}{p._count.products === 0 ? " (no products mapped)" : ""}</option>
              ))}
            </select>
            {program?.description && <p className="mt-1 text-xs text-muted-foreground">{program.description}</p>}
            {issueFor("programId") && <p className="mt-1 text-xs text-status-danger">{issueFor("programId")}</p>}
          </div>
          <div>
            <div className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Step 2 · When should this happen?</div>
            <div className="mt-2 flex items-center gap-3">
              <Label htmlFor="cycle" className="text-sm">Delivery cycle</Label>
              <Input id="cycle" type="number" min={MIN_RULE_CYCLE} max={60} className="w-24 tnum" value={Number.isFinite(form.cycleNumber) ? form.cycleNumber : ""} onChange={(e) => setForm({ ...form, cycleNumber: e.target.value === "" ? NaN : Number(e.target.value) })} disabled={!canManage} />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{CYCLE_ONE_EXPLANATION}</p>
            {issueFor("cycleNumber") && issueFor("cycleNumber") !== CYCLE_ONE_EXPLANATION && <p className="mt-1 text-xs text-status-danger">{issueFor("cycleNumber")}</p>}
            {!cycleOk && Number.isFinite(form.cycleNumber) && <p className="mt-1 text-xs text-status-danger">Delivery cycle must be {MIN_RULE_CYCLE} or higher.</p>}
            {milestoneTaken && (
              <p className="mt-1 text-xs text-status-danger">
                A rule already exists for this programme and delivery {form.cycleNumber}: “{milestoneTaken.name}” ({milestoneTaken.status.toLowerCase()}). V1 allows one milestone rule per programme + cycle — edit or archive that rule instead.
              </p>
            )}
          </div>
          <div>
            <div className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Step 3 · What should we add?</div>
            <select className={cn(selectCls, "mt-2")} value={form.fulfillmentMarkerId} onChange={(e) => setForm({ ...form, fulfillmentMarkerId: e.target.value })} disabled={!canManage}>
              {options.markers.length === 0 && <option value="">No fulfilment markers yet — create one on Products</option>}
              {options.markers.map((m) => (
                <option key={m.id} value={m.id}>{m.name} — {m.title ?? "untitled"}{m.sku ? ` (${m.sku})` : ""} · {m.integration.displayName}</option>
              ))}
            </select>
            {marker && <p className="mt-1 font-mono text-[11px] text-muted-foreground">external variant {marker.externalVariantId}</p>}
            {issueFor("fulfillmentMarkerId") && <p className="mt-1 text-xs text-status-danger">{issueFor("fulfillmentMarkerId")}</p>}
          </div>
          <div>
            <div className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Step 4 · Who counts towards the milestone?</div>
            <div className="mt-2 space-y-2">
              {(["PER_SUBSCRIPTION", "CUSTOMER_PROGRAM"] as const).map((s) => (
                <label key={s} className={cn("flex cursor-pointer items-start gap-2 rounded-lg border p-2.5", form.eligibilityScope === s ? "border-foreground/40 bg-surface" : "border-border")}>
                  <input type="radio" name="scope" className="mt-1" checked={form.eligibilityScope === s} onChange={() => setForm({ ...form, eligibilityScope: s })} disabled={!canManage} />
                  <span>
                    <span className="text-sm font-medium">{eligibilityScopeLabel[s].label}</span>
                    <span className="block text-xs text-muted-foreground">{eligibilityScopeLabel[s].description}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">Not chosen by default — compare both in the impact preview first. The rule can be saved as a draft without it, but cannot be marked Ready.</p>
          </div>
        </section>

        <section className="space-y-3 rounded-xl border border-border bg-card p-5">
          <div className="space-y-1.5">
            <Label htmlFor="rule-name">Rule name</Label>
            <Input id="rule-name" value={form.name} placeholder={defaultName || "e.g. Morning Magic Powder · delivery 2 → Morning Magic 2"} onChange={(e) => setForm({ ...form, name: e.target.value })} disabled={!canManage} />
            {issueFor("name") && <p className="text-xs text-status-danger">{issueFor("name")}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rule-desc">Internal note <span className="text-muted-foreground">(optional)</span></Label>
            <Textarea id="rule-desc" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} disabled={!canManage} />
          </div>
        </section>

        {program && marker && cycleOk && (
          <section className="rounded-xl border border-border bg-surface p-4">
            <div className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Preview</div>
            <p className="mt-1 text-sm">{ruleSentence(program.name, form.cycleNumber, marker.title ?? marker.name)}</p>
            <p className="mt-1 text-xs text-muted-foreground">Decision happens when delivery {form.cycleNumber - 1} succeeds; the marker is attached near the target charge (lead time in Settings). Nothing is attached in this phase.</p>
          </section>
        )}

        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => save(false)} disabled={saving || !canSaveDraft}>{saving ? "Saving…" : initial?.id ? "Save changes" : "Save as draft"}</Button>
            <Button onClick={() => save(true)} disabled={saving || !canReady} title={!canReady ? readyBlockers.map((i) => i.message).join(" ") : undefined}>Save &amp; mark Ready</Button>
            <span className="text-xs text-muted-foreground">Ready ≠ live. No rule can plan or execute actions until the automation engine phase.</span>
          </div>
        )}
      </div>

      <div className="space-y-3">
        <div className="text-sm font-semibold">Activation impact analysis</div>
        {!form.programId || !cycleOk ? (
          <p className="text-sm text-muted-foreground">Choose a programme and a delivery cycle to see who would be affected.</p>
        ) : loadingImpact && !impact ? (
          <p className="text-sm text-muted-foreground">Calculating from imported data…</p>
        ) : impactError ? (
          <p className="text-sm text-status-danger">{impactError}</p>
        ) : impact ? (
          <div className={cn(loadingImpact && "opacity-60")}>
            <ImpactPanel impact={impact} markerName={marker?.title ?? marker?.name} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
