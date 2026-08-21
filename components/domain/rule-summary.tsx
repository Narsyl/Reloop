import { ordinal } from "@/lib/format";

/**
 * The human sentence for a rule. Used in lists, the builder preview and
 * confirmation dialogs so the wording is identical everywhere.
 */
export function ruleSentence(programName: string, cycleNumber: number, markerName: string): string {
  return `When ${programName} reaches delivery #${cycleNumber}, add ${markerName} to the upcoming shipment.`;
}

export function RuleSummary({
  programName,
  cycleNumber,
  markerName,
  compact = false,
}: {
  programName: string;
  cycleNumber: number;
  markerName: string;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <span className="text-sm text-muted-foreground">
        <span className="text-foreground">{programName}</span> · {ordinal(cycleNumber)} delivery →{" "}
        <span className="text-foreground">{markerName}</span>
      </span>
    );
  }
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">When</span>
      <span>
        <span className="font-medium">{programName}</span> reaches delivery cycle{" "}
        <span className="tnum font-medium">{cycleNumber}</span>
      </span>
      <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Then</span>
      <span>
        Add fulfilment marker <span className="font-medium">{markerName}</span> to the upcoming shipment
      </span>
    </div>
  );
}
