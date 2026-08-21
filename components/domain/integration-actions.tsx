"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { RefreshCw, ShieldCheck, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmationDialog } from "@/components/domain/confirmation-dialog";
import { disconnectIntegration, recheckCapabilities, requestSync } from "@/lib/domain/integrations/actions";

export function IntegrationActions({
  integrationId,
  displayName,
  canManage,
  canOperate,
  syncRunning,
  hasSynced,
}: {
  integrationId: string;
  displayName: string;
  canManage: boolean;
  canOperate: boolean;
  syncRunning: boolean;
  hasSynced: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function sync(kind: "INITIAL" | "INCREMENTAL") {
    start(async () => {
      const res = await requestSync(integrationId, kind);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(kind === "INITIAL" ? "Full import queued" : "Sync queued");
      router.refresh();
    });
  }
  function recheck() {
    start(async () => {
      const res = await recheckCapabilities(integrationId);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Capabilities re-checked");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {canOperate && (
        <>
          <Button size="sm" variant="outline" onClick={() => sync(hasSynced ? "INCREMENTAL" : "INITIAL")} disabled={pending || syncRunning}>
            <RefreshCw data-icon="inline-start" className={syncRunning ? "animate-spin" : ""} />
            {syncRunning ? "Syncing…" : hasSynced ? "Sync now" : "Start import"}
          </Button>
          {hasSynced && (
            <ConfirmationDialog
              trigger={<Button size="sm" variant="ghost" disabled={pending || syncRunning}>Full re-import</Button>}
              title="Run a full re-import?"
              impact={`Every product, customer, subscription and historical order will be re-read from ${displayName} and reconciled with what we already have. Nothing is written to Recharge. Duplicates cannot be created; this can take a while on large stores.`}
              confirmLabel="Run full import"
              onConfirm={async () => {
                const r = await requestSync(integrationId, "INITIAL");
                if (r.ok) router.refresh();
                return r;
              }}
              successMessage="Full import queued"
            />
          )}
          <Button size="sm" variant="ghost" onClick={recheck} disabled={pending}>
            <ShieldCheck data-icon="inline-start" /> Re-check capabilities
          </Button>
        </>
      )}
      {canManage && (
        <ConfirmationDialog
          trigger={<Button size="sm" variant="destructive" disabled={pending}><Unplug data-icon="inline-start" /> Disconnect</Button>}
          title={`Disconnect ${displayName}?`}
          impact="The stored credentials will be deleted and automation for this store will stop. Imported subscriptions, history and activity are kept for reference. You can reconnect later with a new token."
          confirmLabel="Disconnect"
          destructive
          confirmWord="disconnect"
          onConfirm={async () => {
            const r = await disconnectIntegration(integrationId);
            if (r.ok) {
              router.push("/settings/integrations");
              router.refresh();
            }
            return r;
          }}
          successMessage="Disconnected"
        />
      )}
    </div>
  );
}
