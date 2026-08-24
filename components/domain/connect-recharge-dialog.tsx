"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { CheckCircle2, Circle, ShieldCheck } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { connectRecharge, testRechargeConnection, type ConnectionTestResult } from "@/lib/domain/integrations/actions";
import { cn } from "@/lib/utils";

const REQUIRED: { key: keyof ConnectionTestResult["capabilities"]; label: string }[] = [
  { key: "store", label: "Store information" },
  { key: "customers", label: "Customers" },
  { key: "products", label: "Products" },
  { key: "orders", label: "Orders" },
  { key: "subscriptions", label: "Subscriptions" },
  { key: "onetimes", label: "One-times" },
  { key: "webhooks", label: "Webhooks" },
];
const OPTIONAL: { key: keyof ConnectionTestResult["capabilities"]; label: string }[] = [
  { key: "charges", label: "Charges (verification)" },
  { key: "events", label: "Events API" },
  { key: "credits", label: "Credits" },
  { key: "customer_sessions", label: "Storefront sessions" },
];

function capLabel(v: string) {
  if (v === "read_write") return "read / write";
  if (v === "derived") return "derived from subscriptions (no /products on this platform)";
  if (v === "unavailable") return "not on plan / no permission";
  if (v === "unknown") return "could not verify";
  return v;
}

export function ConnectRechargeDialog({ disabled }: { disabled?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [apiToken, setApiToken] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [result, setResult] = useState<ConnectionTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, startTest] = useTransition();
  const [connecting, startConnect] = useTransition();

  function reset() {
    setApiToken("");
    setClientSecret("");
    setResult(null);
    setError(null);
  }

  function test() {
    setError(null);
    setResult(null);
    startTest(async () => {
      const res = await testRechargeConnection({ apiToken, clientSecret });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setResult(res.data!);
    });
  }

  function connect() {
    startConnect(async () => {
      const res = await connectRecharge({ apiToken, clientSecret });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast.success("Recharge connected. The import has started and only reads.");
      setOpen(false);
      reset();
      router.push(`/settings/integrations/${res.data!.integrationId}`);
      router.refresh();
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger render={<Button disabled={disabled} />}>Connect Recharge</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect Recharge</DialogTitle>
          <DialogDescription>
            Create an API token in Recharge with <span className="font-medium text-foreground">Customers, Products, Orders and Store information set to view</span> and{" "}
            <span className="font-medium text-foreground">Subscriptions set to view and manage</span>. No premium Recharge features are needed. We test the token before saving it, and the first import only reads.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="rc-token">Recharge API token</Label>
            <Input id="rc-token" type="password" autoComplete="off" value={apiToken} onChange={(e) => { setApiToken(e.target.value); setResult(null); }} placeholder="sk_…" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rc-secret">API client secret <span className="text-muted-foreground">(optional, used later for webhook verification; leave blank if you don&apos;t have it)</span></Label>
            <Input id="rc-secret" type="password" autoComplete="off" value={clientSecret} onChange={(e) => { setClientSecret(e.target.value); setResult(null); }} />
          </div>
          <p className="text-xs text-muted-foreground">Credentials are encrypted before storage and only ever decrypted on the server for this organisation.</p>
        </div>

        {error && <p role="alert" className="rounded-md bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{error}</p>}

        {result && (
          <div className="space-y-3 rounded-lg border border-border bg-surface p-3 text-sm">
            <div className="flex items-start gap-2">
              <ShieldCheck className={cn("mt-0.5 size-4", result.requiredOk ? "text-status-success" : "text-status-danger")} />
              <div>
                <div className="font-medium">{result.store.name}</div>
                <div className="text-xs text-muted-foreground">
                  {result.store.domain ?? result.store.externalStoreId}
                  {result.store.currency ? ` · ${result.store.currency}` : ""}
                  {result.store.timezone ? ` · ${result.store.timezone}` : ""}
                </div>
                <div className={cn("mt-1 text-xs font-medium", result.requiredOk ? "text-status-success" : "text-status-danger")}>
                  {result.requiredOk ? "Everything Reloop needs is available." : "Some required access is missing. Fix the token permissions and test again."}
                </div>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <ul className="space-y-1">
                {REQUIRED.map((c) => {
                  const v = result.capabilities[c.key];
                  const ok = v !== "unavailable" && v !== "unknown";
                  return (
                    <li key={c.key} className="flex items-center justify-between gap-2 text-xs">
                      <span className="flex items-center gap-1.5">
                        {ok ? <CheckCircle2 className="size-3.5 text-status-success" /> : <Circle className="size-3.5 text-status-danger" />}
                        {c.label}
                      </span>
                      <span className="text-muted-foreground">{capLabel(v)}</span>
                    </li>
                  );
                })}
              </ul>
              <ul className="space-y-1">
                <li className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Optional</li>
                {OPTIONAL.map((c) => {
                  const v = result.capabilities[c.key];
                  return (
                    <li key={c.key} className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1.5">
                        <Circle className={cn("size-3.5", v === "available" || v === "read_write" || v === "read" ? "text-status-success" : "text-border")} />
                        {c.label}
                      </span>
                      <span>{capLabel(v)}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
            {result.notes.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                {result.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={test} disabled={testing || connecting || apiToken.trim().length < 20}>
            {testing ? "Testing…" : result ? "Test again" : "Test connection"}
          </Button>
          <Button onClick={connect} disabled={!result || !result.requiredOk || connecting || testing}>
            {connecting ? "Connecting…" : "Save & start read-only import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
