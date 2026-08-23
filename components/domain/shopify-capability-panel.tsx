import type { ShopifyCapabilityReport } from "@/lib/integrations/shopify";
import { cn } from "@/lib/utils";

const Row = ({ label, state }: { label: string; state: "available" | "unavailable" | "not-requested" }) => (
  <li className="flex items-center justify-between gap-3 py-1 text-sm">
    <span>{label}</span>
    <span className={cn("text-xs font-medium", state === "available" ? "text-status-success" : state === "unavailable" ? "text-status-danger" : "text-muted-foreground")}>{state === "available" ? "✓ available" : state === "unavailable" ? "✗ unavailable" : "Not requested"}</span>
  </li>
);

/** Makes it obvious how little permission the Shopify connector has. */
export function ShopifyCapabilityPanel({ report, compact }: { report: ShopifyCapabilityReport; compact?: boolean }) {
  return (
    <div className={cn("grid gap-4", compact ? "" : "sm:grid-cols-2")}>
      <div>
        <div className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Requested (least privilege)</div>
        <ul className="divide-y divide-border rounded-lg border border-border px-3">
          <Row label="Store identity" state={report.storeIdentity} />
          <Row label="Products read" state={report.productsRead} />
          <Row label="Products write (marker products only)" state={report.productsWrite} />
          <Row label="Publication read" state={report.publicationsRead} />
          <Row label="Publication write (Online Store)" state={report.publicationsWrite} />
        </ul>
        <p className="mt-1 text-[11px] text-muted-foreground">Scopes granted: {report.grantedScopes.join(", ") || "—"}{report.onlineStorePublicationId ? " · Online Store channel found" : " · Online Store channel NOT found"}</p>
        {report.unexpectedScopes.length > 0 ? <p className="mt-1 text-[11px] text-status-warning">Extra scopes granted but never used: {report.unexpectedScopes.join(", ")} — consider removing them from the custom app.</p> : null}
        {report.missingScopes.length > 0 ? <p className="mt-1 text-[11px] text-status-danger">Missing: {report.missingScopes.join(", ")}</p> : null}
      </div>
      <div>
        <div className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Never requested</div>
        <ul className="divide-y divide-border rounded-lg border border-border px-3">
          {report.notRequested.map((a) => <Row key={a} label={a.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())} state="not-requested" />)}
        </ul>
        <p className="mt-1 text-[11px] text-muted-foreground">Shopify is catalogue + marker identity only. Recharge stays the subscription, lifecycle and one-time authority; this connector never reads orders or customers and never edits orders.</p>
      </div>
    </div>
  );
}
