import Link from "next/link";
import { requireOrg } from "@/lib/auth/tenancy";
import { listPrograms, listMarkers } from "@/lib/domain/queries/products";
import { PageHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/data/empty-state";
import { Button } from "@/components/ui/button";

export const metadata = { title: "New rule" };

/**
 * Phase 1 placeholder: the 3-step builder (program → cycle → marker, with preview
 * and impact) is built in Phase 4. This page explains the prerequisites so the
 * navigation is honest rather than a dead end.
 */
export default async function NewRulePage() {
  const ctx = await requireOrg();
  const [programs, markers] = await Promise.all([listPrograms(ctx), listMarkers(ctx)]);
  return (
    <>
      <PageHeader eyebrow={<Link href="/rules" className="hover:underline">Rules</Link>} title="New rule" description="Rules are created in three steps: choose a subscription program, the delivery cycle, and the fulfilment marker to add." />
      <EmptyState
        title="The rule builder arrives with Phase 4"
        description={`You have ${programs.length} subscription program${programs.length === 1 ? "" : "s"} and ${markers.length} fulfilment marker${markers.length === 1 ? "" : "s"} configured. Both are prerequisites; once the builder ships you will see a live preview and an impact estimate before saving.`}
        action={
          <Button variant="outline" render={<Link href="/products" />}>
            Review programs and markers
          </Button>
        }
      />
    </>
  );
}
