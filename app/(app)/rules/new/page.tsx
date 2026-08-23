import Link from "next/link";
import { hasRole, requireOrg } from "@/lib/auth/tenancy";
import { getRuleBuilderOptions } from "@/lib/domain/queries/rules";
import { PageHeader } from "@/components/layout/page-header";
import { RuleBuilder } from "@/components/domain/rule-builder";
import { EmptyState } from "@/components/data/empty-state";
import { Button } from "@/components/ui/button";

export const metadata = { title: "New rule" };

export default async function NewRulePage() {
  const ctx = await requireOrg();
  const options = await getRuleBuilderOptions(ctx);
  const canManage = hasRole(ctx, "ADMIN");
  const missing = [options.programs.length === 0 ? "a subscription programme with mapped products" : null, options.markers.length === 0 ? "an active fulfilment marker" : null].filter(Boolean);

  return (
    <>
      <PageHeader
        eyebrow={<Link href="/rules" className="hover:underline">Rules</Link>}
        title="New rule"
        description="Four steps: programme → delivery cycle → fulfilment marker → who counts. The impact preview on the right is calculated live from your imported subscriptions."
      />
      {missing.length > 0 ? (
        <EmptyState
          title={`You need ${missing.join(" and ")} first`}
          description="Programmes group the products that share one delivery-cycle journey; markers are the £0 items inserted into shipments. Both are configured on the Products page."
          action={<Button variant="outline" render={<Link href="/products" />}>Go to Products</Button>}
        />
      ) : (
        <RuleBuilder options={options} canManage={canManage} />
      )}
    </>
  );
}
