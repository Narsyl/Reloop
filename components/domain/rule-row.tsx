"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { setRuleEnabled } from "@/lib/domain/rules/actions";
import { enabledStatus } from "@/lib/status";
import { formatRelative, ordinal, pluralize } from "@/lib/format";
import { ruleSentence } from "@/components/domain/rule-summary";
import { StatusBadge } from "@/components/status/status-badge";
import { ConfirmationDialog } from "@/components/domain/confirmation-dialog";
import { Button } from "@/components/ui/button";

export type RuleRowData = {
  id: string;
  name: string;
  enabled: boolean;
  cycleNumber: number;
  programName: string;
  markerName: string;
  markerSku: string | null;
  liveActions: number;
  totalActions: number;
  lastTriggeredAt: Date | null;
};

export function RuleRow({ rule, canManage }: { rule: RuleRowData; canManage: boolean }) {
  const router = useRouter();
  const sentence = ruleSentence(rule.programName, rule.cycleNumber, rule.markerName);
  return (
    <li className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/rules/${rule.id}`} className="text-sm font-semibold hover:underline">
            {rule.name}
          </Link>
          <StatusBadge status={enabledStatus(rule.enabled)} />
        </div>
        <p className="text-sm text-muted-foreground">{sentence}</p>
        <p className="text-xs text-muted-foreground">
          {rule.programName} · {ordinal(rule.cycleNumber)} delivery → {rule.markerName}
          {rule.markerSku ? ` (${rule.markerSku})` : ""} · {pluralize(rule.liveActions, "queued action")}
          {rule.lastTriggeredAt ? ` · last triggered ${formatRelative(rule.lastTriggeredAt)}` : " · never triggered"}
        </p>
      </div>
      {canManage && (
        <div className="flex shrink-0 items-center gap-2">
          {rule.enabled ? (
            <ConfirmationDialog
              trigger={<Button size="sm" variant="outline">Disable</Button>}
              title="Disable this rule?"
              impact={`New ${rule.programName} subscriptions reaching delivery #${rule.cycleNumber} will no longer receive "${rule.markerName}". Actions already queued are not removed.`}
              confirmLabel="Disable rule"
              onConfirm={async () => {
                const r = await setRuleEnabled({ id: rule.id, enabled: false });
                if (r.ok) router.refresh();
                return r;
              }}
              successMessage="Rule disabled"
            />
          ) : (
            <ConfirmationDialog
              trigger={<Button size="sm">Activate</Button>}
              title="Activate this rule?"
              impact={`Future ${rule.programName} subscriptions reaching delivery #${rule.cycleNumber} will automatically receive the fulfilment marker "${rule.markerName}" on their upcoming shipment.`}
              confirmLabel="Activate rule"
              onConfirm={async () => {
                const r = await setRuleEnabled({ id: rule.id, enabled: true });
                if (r.ok) router.refresh();
                return r;
              }}
              successMessage="Rule activated"
            />
          )}
        </div>
      )}
    </li>
  );
}
