"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { KeyRound, Radio, Unplug } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { registerWebhooks, saveWebhookSecret, unregisterWebhooks } from "@/lib/domain/webhooks/actions";

export function WebhookSecretDialog({ integrationId, configured }: { integrationId: string; configured: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, start] = useTransition();
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setSecret(""); setError(null); } }}>
      <DialogTrigger render={<span className="contents" />}><Button size="xs" variant="outline"><KeyRound data-icon="inline-start" /> {configured ? "Replace secret" : "Set client secret"}</Button></DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Webhook / API client secret</DialogTitle>
          <DialogDescription>The Recharge API client secret (separate from the API token) validates the X-Recharge-Hmac-Sha256 signature on every delivery. Stored encrypted with the integration credentials; never shown again, never logged.</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="wh-secret">Client secret</Label>
          <Input id="wh-secret" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} className="font-mono" autoComplete="off" />
        </div>
        {error ? <p className="rounded-lg border border-status-danger/30 bg-status-danger-bg px-3 py-2 text-xs text-status-danger">{error}</p> : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
          <Button disabled={saving || secret.trim().length < 6} onClick={() => start(async () => {
            const r = await saveWebhookSecret({ integrationId, clientSecret: secret });
            if (!r.ok) { setError(r.error); return; }
            toast.success("Webhook client secret saved (encrypted)");
            setOpen(false);
            router.refresh();
          })}>{saving ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RegisterWebhooksControl({ integrationId, defaultBaseUrl, registered, secretConfigured }: { integrationId: string; defaultBaseUrl: string; registered: boolean; secretConfigured: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState(defaultBaseUrl);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  return (
    <span className="inline-flex items-center gap-1">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger render={<span className="contents" />}><Button size="xs" variant="outline" disabled={!secretConfigured} title={secretConfigured ? undefined : "Set the client secret first — deliveries could not be validated"}><Radio data-icon="inline-start" /> {registered ? "Re-register" : "Register webhooks"}</Button></DialogTrigger>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Register Recharge webhooks</DialogTitle>
            <DialogDescription>Subscribes order/created, order/processed and the four subscription topics, delivering to this platform&rsquo;s public https URL. Webhook payloads are treated as signals only — processing re-reads Recharge and runs the existing import/recalculation code. The 4-hourly incremental sync stays on as the backstop.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="wh-base">Public base URL (https)</Label>
            <Input id="wh-base" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://ops.example.com" className="font-mono" />
            <p className="text-[11px] text-muted-foreground">Endpoint: <span className="font-mono">{baseUrl.replace(/\/+$/, "") || "…"}/api/webhooks/recharge/{integrationId}</span></p>
          </div>
          {error ? <p className="rounded-lg border border-status-danger/30 bg-status-danger-bg px-3 py-2 text-xs text-status-danger">{error}</p> : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button disabled={busy || !/^https:\/\/.+/i.test(baseUrl.trim())} onClick={() => start(async () => {
              setError(null);
              const r = await registerWebhooks({ integrationId, baseUrl });
              if (!r.ok) { setError(r.error); return; }
              toast.success(`Webhooks registered — ${r.data!.created.length} created, ${r.data!.kept.length} already correct`);
              setOpen(false);
              router.refresh();
            })}>{busy ? "Registering…" : "Register"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {registered ? (
        <Button size="xs" variant="ghost" disabled={busy} onClick={() => {
          if (!window.confirm("Unregister this platform's Recharge webhooks? The incremental cron keeps everything correct, just slower.")) return;
          start(async () => {
            const r = await unregisterWebhooks(integrationId);
            if (!r.ok) { toast.error(r.error); return; }
            toast.success(`Webhooks removed (${r.data!.removed})`);
            router.refresh();
          });
        }}><Unplug data-icon="inline-start" /> Unregister</Button>
      ) : null}
    </span>
  );
}
