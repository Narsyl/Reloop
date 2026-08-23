"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Plus, Pencil } from "lucide-react";
import type { EligibilityScope, RewardScheduleStatus } from "@prisma/client";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmationDialog } from "@/components/domain/confirmation-dialog";
import { assignScheduleToProgram, deleteMilestone, migrateLegacyRule, saveMilestone, saveRewardItem, saveRewardSchedule, setScheduleStatus } from "@/lib/domain/rewards/actions";
import { eligibilityScopeLabel } from "@/lib/status";

const selectCls = "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

// ── Reward items ───────────────────────────────────────────────────────────

export function RewardItemDialog({ initial, trigger }: { initial?: { id: string; name: string; description: string; operationalDescription: string; active: boolean }; trigger?: React.ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(initial ?? { name: "", description: "", operationalDescription: "", active: true });
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [saving, start] = useTransition();
  function submit() {
    setErrors({});
    start(async () => {
      const r = await saveRewardItem({ ...(initial ? { id: initial.id } : {}), ...form });
      if (!r.ok) {
        setErrors(r.fieldErrors ?? {});
        toast.error(r.error);
        return;
      }
      toast.success(initial ? "Reward item updated" : "Reward item created");
      setOpen(false);
      router.refresh();
    });
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<span className="contents" />}>{trigger ?? <Button size="sm"><Plus data-icon="inline-start" /> New reward item</Button>}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{initial ? "Edit reward item" : "New reward item"}</DialogTitle>
          <DialogDescription>What physically happens at a milestone — e.g. Whisk, Cup, Spoon, sample sachet. No stock or pricing: operator meaning and audit only.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="ri-name">Name</Label>
            <Input id="ri-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Cup" />
            {errors.name && <p className="text-xs text-status-danger">{errors.name[0]}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ri-op">Operational description <span className="text-muted-foreground">(what the warehouse does)</span></Label>
            <Input id="ri-op" value={form.operationalDescription} onChange={(e) => setForm({ ...form, operationalDescription: e.target.value })} placeholder="Include the ceramic cup" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ri-desc">Notes</Label>
            <Textarea id="ri-desc" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          {initial ? (
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Active</label>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
          <Button onClick={submit} disabled={saving || !form.name}>{saving ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Schedules ──────────────────────────────────────────────────────────────

export function ScheduleDialog({ initial, trigger }: { initial?: { id: string; name: string; description: string }; trigger?: React.ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(initial ?? { name: "", description: "" });
  const [saving, start] = useTransition();
  function submit() {
    start(async () => {
      const r = await saveRewardSchedule({ ...(initial ? { id: initial.id } : {}), ...form });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(initial ? "Schedule updated" : "Schedule created (draft)");
      setOpen(false);
      if (!initial && r.data?.id) router.push(`/rewards/${r.data.id}`);
      else router.refresh();
    });
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<span className="contents" />}>{trigger ?? <Button><Plus data-icon="inline-start" /> New schedule</Button>}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{initial ? "Edit reward schedule" : "New reward schedule"}</DialogTitle>
          <DialogDescription>A reusable list of milestones (delivery number → reward). Many programmes can share one schedule; each programme keeps its own lifecycle and reward history.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="sc-name">Name</Label>
            <Input id="sc-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Schedule A — Whisk at 2, Cup at 3" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sc-desc">Description</Label>
            <Textarea id="sc-desc" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
          <Button onClick={submit} disabled={saving || form.name.trim().length < 2}>{saving ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ScheduleStatusControls({ id, name, status, programs }: { id: string; name: string; status: RewardScheduleStatus; programs: number }) {
  const router = useRouter();
  const change = (to: RewardScheduleStatus) => async () => {
    const r = await setScheduleStatus({ id, status: to });
    if (r.ok) router.refresh();
    return r;
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      {status === "DRAFT" && (
        <ConfirmationDialog
          trigger={<Button size="sm">Mark ready</Button>}
          title={`Mark "${name}" ready?`}
          impact={`Ready means the configuration is signed off: the dry-run planner will plan this schedule's renewal milestones for ${programs} programme(s) — only where the milestone's reward item is bound to a verified Shopify variant for the programme's store. Nothing is written to the subscription platform in this phase; initial-checkout milestones are never planned.`}
          confirmLabel="Mark ready"
          onConfirm={change("READY")}
          successMessage="Schedule is ready"
        />
      )}
      {status === "READY" && (
        <ConfirmationDialog
          trigger={<Button size="sm" variant="outline">Back to draft</Button>}
          title={`Return "${name}" to draft?`}
          impact="The planner stops using it; planned actions from its milestones are cancelled on the next run (SCHEDULE_NOT_READY)."
          confirmLabel="Back to draft"
          onConfirm={change("DRAFT")}
          successMessage="Schedule is a draft again"
        />
      )}
      {status !== "ARCHIVED" && (
        <ConfirmationDialog
          trigger={<Button size="sm" variant="ghost">Archive</Button>}
          title={`Archive "${name}"?`}
          impact="Archived schedules cannot be assigned or edited. Programmes keep their assignment but nothing is planned from an archived schedule."
          confirmLabel="Archive"
          destructive
          onConfirm={change("ARCHIVED")}
          successMessage="Schedule archived"
        />
      )}
    </div>
  );
}

// ── Milestones ─────────────────────────────────────────────────────────────

export type MilestoneFormInitial = { id?: string; cycleNumber: number | ""; rewardItemId: string; eligibilityScope: EligibilityScope | ""; active: boolean; notes: string };

export function MilestoneDialog({ scheduleId, items, initial, trigger }: { scheduleId: string; items: { id: string; name: string }[]; initial?: MilestoneFormInitial; trigger?: React.ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<MilestoneFormInitial>(initial ?? { cycleNumber: "", rewardItemId: items[0]?.id ?? "", eligibilityScope: "", active: true, notes: "" });
  const [saving, start] = useTransition();
  const mode = form.cycleNumber === 1 ? "INITIAL_CHECKOUT" : form.cycleNumber === "" ? null : "UPCOMING_RENEWAL";
  function submit() {
    start(async () => {
      const r = await saveMilestone({ ...(initial?.id ? { id: initial.id } : {}), scheduleId, cycleNumber: form.cycleNumber, rewardItemId: form.rewardItemId, eligibilityScope: form.eligibilityScope, active: form.active, notes: form.notes });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(initial?.id ? "Milestone updated" : "Milestone added");
      setOpen(false);
      router.refresh();
    });
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<span className="contents" />}>{trigger ?? <Button size="sm"><Plus data-icon="inline-start" /> Add milestone</Button>}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{initial?.id ? "Edit milestone" : "Add milestone"}</DialogTitle>
          <DialogDescription>Delivery number → reward item. Delivery 1 is an initial-checkout milestone (recorded, never planned by the renewal planner); later deliveries are planned before the charge.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ms-cycle">Delivery number</Label>
              <Input id="ms-cycle" type="number" min={1} max={60} value={form.cycleNumber} onChange={(e) => setForm({ ...form, cycleNumber: e.target.value === "" ? "" : Number(e.target.value) })} />
              {mode ? <p className="text-xs text-muted-foreground">{mode === "INITIAL_CHECKOUT" ? "Initial checkout — part of the first order by construction." : "Upcoming renewal — planned before the charge."}</p> : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ms-item">Reward item</Label>
              <select id="ms-item" className={selectCls} value={form.rewardItemId} onChange={(e) => setForm({ ...form, rewardItemId: e.target.value })}>
                {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Who counts towards this milestone? <span className="text-status-danger">*</span></Label>
            <div className="grid gap-2 sm:grid-cols-2">
              {(["CUSTOMER_PROGRAM", "PER_SUBSCRIPTION"] as const).map((s) => (
                <button key={s} type="button" onClick={() => setForm({ ...form, eligibilityScope: s })} className={`rounded-lg border p-2 text-left text-xs ${form.eligibilityScope === s ? "border-foreground/40 bg-surface" : "border-border hover:bg-muted/50"}`}>
                  <span className="block text-sm font-medium">{eligibilityScopeLabel[s].label}</span>
                  <span className="text-muted-foreground">{eligibilityScopeLabel[s].description}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ms-notes">Notes</Label>
            <Textarea id="ms-notes" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
          {initial?.id ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Active</label> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
          <Button onClick={submit} disabled={saving || form.cycleNumber === "" || !form.rewardItemId || !form.eligibilityScope}>{saving ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteMilestoneButton({ id, scheduleId, label }: { id: string; scheduleId: string; label: string }) {
  const router = useRouter();
  return (
    <ConfirmationDialog
      trigger={<Button size="xs" variant="ghost">Remove</Button>}
      title={`Remove ${label}?`}
      impact="Only possible while no action was planned from it. Prefer deactivating if the milestone ever applied."
      confirmLabel="Remove"
      destructive
      onConfirm={async () => {
        const r = await deleteMilestone({ id, scheduleId });
        if (r.ok) router.refresh();
        return r;
      }}
    />
  );
}

// ── Programme assignment ───────────────────────────────────────────────────

export function AssignProgramControl({ scheduleId, programs }: { scheduleId: string; programs: { id: string; name: string }[] }) {
  const router = useRouter();
  const [programId, setProgramId] = useState(programs[0]?.id ?? "");
  const [pending, start] = useTransition();
  if (programs.length === 0) return <p className="text-xs text-muted-foreground">Every active programme already has a schedule.</p>;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select className={selectCls + " w-64"} value={programId} onChange={(e) => setProgramId(e.target.value)}>
        {programs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <Button size="sm" variant="outline" disabled={pending || !programId} onClick={() => start(async () => {
        const r = await assignScheduleToProgram({ programId, scheduleId });
        if (!r.ok) {
          toast.error(r.error);
          return;
        }
        toast.success("Programme assigned");
        router.refresh();
      })}>{pending ? "Assigning…" : "Assign programme"}</Button>
    </div>
  );
}

export function UnassignProgramButton({ programId, programName }: { programId: string; programName: string }) {
  const router = useRouter();
  return (
    <ConfirmationDialog
      trigger={<Button size="xs" variant="ghost">Remove</Button>}
      title={`Remove "${programName}" from this schedule?`}
      impact="Planned actions from its milestones are cancelled on the next planner run (MILESTONE_NOT_ASSIGNED). Lifecycle history is untouched."
      confirmLabel="Remove"
      destructive
      onConfirm={async () => {
        const r = await assignScheduleToProgram({ programId, scheduleId: null });
        if (r.ok) router.refresh();
        return r;
      }}
    />
  );
}

// ── Legacy rule migration ──────────────────────────────────────────────────

export function MigrateRuleButton({ ruleId, milestones }: { ruleId: string; milestones: { id: string; label: string }[] }) {
  const router = useRouter();
  const [milestoneId, setMilestoneId] = useState(milestones[0]?.id ?? "");
  const [pending, start] = useTransition();
  if (milestones.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-2">
      <select className={selectCls + " w-72"} value={milestoneId} onChange={(e) => setMilestoneId(e.target.value)}>
        {milestones.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
      </select>
      <Button size="xs" variant="outline" disabled={pending || !milestoneId} onClick={() => start(async () => {
        const r = await migrateLegacyRule({ ruleId, milestoneId });
        if (!r.ok) {
          toast.error(r.error);
          return;
        }
        toast.success("Rule archived and linked to the schedule milestone");
        router.refresh();
      })}><Pencil data-icon="inline-start" /> Migrate to milestone</Button>
    </span>
  );
}
