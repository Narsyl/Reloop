"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Play, ShieldOff, FlaskConical, Lock } from "lucide-react";
import type { AutomationMode } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { ConfirmationDialog } from "@/components/domain/confirmation-dialog";
import { runPlannerNow, setAutomationMode } from "@/lib/domain/actions/actions";
import type { PlannerSummary } from "@/lib/domain/actions/planner";
import { cn } from "@/lib/utils";

export function AutomationModeControl({ integrationId, displayName, mode, canManage }: { integrationId: string; displayName: string; mode: AutomationMode; canManage: boolean }) {
  const router = useRouter();
  const [pending] = useTransition();
  const opt = (value: AutomationMode, label: string, desc: string, Icon: typeof Play, disabled?: string) => {
    const selected = mode === value;
    const inner = (
      <span className={cn("flex w-full items-start gap-2 rounded-lg border p-3 text-left", selected ? "border-foreground/40 bg-surface" : "border-border", disabled ? "opacity-60" : "hover:bg-muted/50")}>
        <Icon className="mt-0.5 size-4 shrink-0" />
        <span className="min-w-0">
          <span className="block text-sm font-medium">{label}{selected ? <span className="ml-2 text-xs font-normal text-muted-foreground">current</span> : null}</span>
          <span className="block text-xs text-muted-foreground">{disabled ?? desc}</span>
        </span>
      </span>
    );
    if (disabled || !canManage || selected) return <div key={value} title={disabled}>{inner}</div>;
    return (
      <ConfirmationDialog
        key={value}
        trigger={<button type="button" className="w-full" disabled={pending}>{inner}</button>}
        title={value === "DRY_RUN" ? `Switch ${displayName} to dry run?` : `Switch ${displayName} automation off?`}
        impact={value === "DRY_RUN" ? "The planner will create PLANNED actions for Ready rules and dry-run them (read-only checks + a preview of the exact one-time we would create). Nothing is written to Recharge in this phase." : "The planner stops. Existing planned actions stay as they are and resume being evaluated when dry run is switched back on."}
        confirmLabel={value === "DRY_RUN" ? "Enable dry run" : "Switch off"}
        onConfirm={async () => {
          const r = await setAutomationMode({ integrationId, mode: value });
          if (r.ok) router.refresh();
          return r;
        }}
        successMessage={value === "DRY_RUN" ? "Dry run enabled — planner queued" : "Automation off"}
      />
    );
  };
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {opt("OFF", "Off", "Nothing is planned or previewed.", ShieldOff)}
      {opt("DRY_RUN", "Dry run", "Plan + validate + preview. No writes to the subscription platform.", FlaskConical)}
      {opt("LIVE", "Live", "Attach markers automatically.", Lock, "Live execution is not available in this phase: the connector has no write operation and this mode is refused server-side.")}
    </div>
  );
}

export function RunPlannerButton({ integrationId, disabled, size = "sm", onDone }: { integrationId: string; disabled?: boolean; size?: "sm" | "xs"; onDone?: (s: PlannerSummary) => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [last, setLast] = useState<PlannerSummary | null>(null);
  function run() {
    start(async () => {
      const r = await runPlannerNow(integrationId);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      const s = r.data!;
      setLast(s);
      onDone?.(s);
      if (s.skippedReason === "AUTOMATION_OFF") toast.message("Planner skipped: automation is off for this integration");
      else if (s.skippedReason === "NO_USABLE_RULES") toast.message(`Planner ran: no usable rules (${s.rulesSkipped.map((x) => `${x.name}: ${x.reason}`).join("; ") || "no Ready rules"})`);
      else toast.success(`Planner: ${s.planned} planned · ${s.replanned} replanned · ${s.confirmed} confirmed · ${s.cancelled} cancelled · ${s.superseded} superseded`);
      router.refresh();
    });
  }
  return (
    <span className="inline-flex items-center gap-2">
      <Button size={size} variant="outline" onClick={run} disabled={pending || disabled}>
        <Play data-icon="inline-start" /> {pending ? "Planning…" : "Run planner now"}
      </Button>
      {last?.plannerRunId ? <Link href={`/upcoming?run=${last.plannerRunId}`} className="text-xs text-muted-foreground hover:underline">see run</Link> : null}
    </span>
  );
}
