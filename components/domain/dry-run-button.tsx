"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { FlaskConical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { dryRunNow } from "@/lib/domain/actions/actions";

export function DryRunButton({ actionId, disabled, size = "sm", label = "Dry run now" }: { actionId: string; disabled?: boolean; size?: "sm" | "xs"; label?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  function run() {
    start(async () => {
      const r = await dryRunNow(actionId);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      const d = r.data!;
      if (d.wouldExecute) toast.success(`Dry run: would ${d.operation === "ADOPT_EXISTING_ONETIME" ? "adopt the existing one-time" : "create the one-time"} on ${d.targetChargeDate} — nothing was sent`);
      else toast.message(`Dry run: would NOT execute — ${d.blockingReason}${d.blockingDetail ? ` (${d.blockingDetail})` : ""}`);
      router.refresh();
    });
  }
  return (
    <Button size={size} variant="outline" onClick={run} disabled={pending || disabled} title="Loads fresh internal + read-only Recharge state and previews the exact operation. Never sends it.">
      <FlaskConical data-icon="inline-start" /> {pending ? "Checking…" : label}
    </Button>
  );
}
