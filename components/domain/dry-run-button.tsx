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
      if (d.wouldExecute) toast.success(`Check passed. The gift would be ${d.operation === "ADOPT_EXISTING_ONETIME" ? "adopted from the existing one-time" : "added"} on ${d.targetChargeDate}, and nothing was sent`);
      else toast.message(`Check blocked: ${d.blockingReason}${d.blockingDetail ? ` (${d.blockingDetail})` : ""}`);
      router.refresh();
    });
  }
  return (
    <Button size={size} variant="outline" onClick={run} disabled={pending || disabled} title="Loads fresh internal + read-only Recharge state and previews the exact operation. Never sends it.">
      <FlaskConical data-icon="inline-start" /> {pending ? "Checking…" : label}
    </Button>
  );
}
