"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { EligibilityScope, RuleStatus } from "@prisma/client";
import { setRuleStatus } from "@/lib/domain/rules/actions";
import { eligibilityScopeLabel, ruleStatus } from "@/lib/status";
import { ordinal } from "@/lib/format";
import { ruleSentence } from "@/components/domain/rule-summary";
import { StatusBadge } from "@/components/status/status-badge";
import { ConfirmationDialog } from "@/components/domain/confirmation-dialog";
import { Button } from "@/components/ui/button";

export type RuleRowData = {
  id: string;
  name: string;
  status: RuleStatus;
  cycleNumber: number;
  programName: string;
  markerName: string;
  markerTitle: string | null;
  markerSku: string | null;
  eligibilityScope: EligibilityScope | null;
  liveActions: number;
};

export function RuleRow({ rule, canManage }: { rule: RuleRowData; canManage: boolean }) {
  const router = useRouter();
  const sentence = ruleSentence(rule.programName, rule.cycleNumber, rule.markerTitle ?? rule.markerName);
  const change = (status: RuleStatus) => async () => {
    const r = await setRuleStatus({ id: rule.id, status });
    if (r.ok) router.refresh();
    return r;
  };
  return (
    <li className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/rules/${rule.id}`} className="text-sm font-semibold hover:underline">{rule.name}</Link>
          <StatusBadge status={ruleStatus[rule.status]} />
          {rule.eligibilityScope ? (
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium">{eligibilityScopeLabel[rule.eligibilityScope].label}</span>
          ) : (
            <span className="rounded-md bg-status-warning-bg px-1.5 py-0.5 text-[11px] font-medium text-status-warning">scope not chosen</span>
          )}
        </div>
        <p className="text-sm text-muted-foreground">{sentence}</p>
        <p className="text-xs text-muted-foreground">
          {rule.programName} · {ordinal(rule.cycleNumber)} delivery → {rule.markerName}{rule.markerSku ? ` (${rule.markerSku})` : ""}
          {rule.liveActions > 0 ? ` · ${rule.liveActions} queued actions` : ""}
        </p>
      </div>
      {canManage && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {(rule.status === "DRAFT" || rule.status === "DISABLED") && (
            <ConfirmationDialog
              trigger={<Button size="sm">Mark Ready</Button>}
              title="Mark this rule Ready?"
              impact="Ready means the configuration is complete and validated. It does NOT activate anything — no actions can be planned or executed until the automation engine is enabled for this organisation."
              confirmLabel="Mark Ready"
              onConfirm={change("READY")}
              successMessage="Rule is Ready"
            />
          )}
          {rule.status === "READY" && (
            <ConfirmationDialog
              trigger={<Button size="sm" variant="outline">Disable</Button>}
              title="Disable this rule?"
              impact="The rule keeps its configuration but is marked intentionally off."
              confirmLabel="Disable"
              onConfirm={change("DISABLED")}
              successMessage="Rule disabled"
            />
          )}
          {rule.status !== "ACTIVE" && (
            <ConfirmationDialog
              trigger={<Button size="sm" variant="ghost">Archive</Button>}
              title="Archive this rule?"
              impact={`“${rule.name}” is retired and its milestone (${rule.programName} · delivery ${rule.cycleNumber}) becomes available for a new rule. History is kept.`}
              confirmLabel="Archive"
              destructive
              onConfirm={change("ARCHIVED")}
              successMessage="Rule archived"
            />
          )}
        </div>
      )}
    </li>
  );
}
