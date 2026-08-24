import type { ShopifyCapabilityReport } from "@/lib/integrations/shopify";
import { cn } from "@/lib/utils";

const Row = ({ label, state, hint }: { label: string; state: "available" | "unavailable" | "not-granted" | "not-requested"; hint?: string }) => (
  <li className="flex items-center justify-between gap-3 py-1 text-sm">
    <span>
      {label}
      {hint ? <span className="ml-1 text-[11px] text-muted-foreground">({hint})</span> : null}
    </span>
    <span className={cn("text-xs font-medium", state === "available" ? "text-status-success" : state === "unavailable" ? "text-status-danger" : "text-muted-foreground")}>
      {state === "available" ? "available" : state === "unavailable" ? "unavailable" : state === "not-granted" ? "not granted (optional)" : "never requested"}
    </span>
  </li>
);

/** Makes it obvious how little permission the read-only Shopify connector has. */
export function ShopifyCapabilityPanel({ report, compact }: { report: ShopifyCapabilityReport; compact?: boolean }) {
  return (
    <div className={cn("grid gap-4", compact ? "" : "sm:grid-cols-2")}>
      <div>
        <div className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Requested (read-only, least privilege)</div>
        <ul className="divide-y divide-border rounded-lg border border-border px-3">
          <Row label="Store identity" state={report.storeIdentity} />
          <Row label="Products read" state={report.productsRead} hint="required, used to search and verify gift products" />
          <Row label="Publications read" state={report.publicationsRead} hint="optional, shows whether a product is on the Online Store" />
        </ul>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Scopes granted: {report.grantedScopes.join(", ") || "none"}. Auth: {report.authMode === "CLIENT_CREDENTIALS" ? "client credentials with a server side token that refreshes automatically" : "access token"}
        </p>
        {report.unexpectedScopes.length > 0 ? <p className="mt-1 text-[11px] text-status-warning">Extra scopes granted but never used: {report.unexpectedScopes.join(", ")}. Consider removing them from the app.</p> : null}
        {report.missingScopes.length > 0 ? <p className="mt-1 text-[11px] text-status-danger">Missing: {report.missingScopes.join(", ")}</p> : null}
      </div>
      <div>
        <div className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Never requested</div>
        <ul className="divide-y divide-border rounded-lg border border-border px-3">
          {report.notRequested.map((a) => <Row key={a} label={a.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())} state="not-requested" />)}
        </ul>
        <p className="mt-1 text-[11px] text-muted-foreground">Shopify is a read-only catalogue here: it names the physical reward variants. Recharge stays the subscription, lifecycle and one-time authority; this connector has no write surface and never reads orders or customers.</p>
      </div>
    </div>
  );
}
