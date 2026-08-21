import Link from "next/link";
import { SearchX } from "lucide-react";
import { EmptyState } from "@/components/data/empty-state";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <EmptyState
      icon={SearchX}
      title="Not found"
      description="That record doesn't exist in this organisation, or you don't have access to it."
      action={<Button variant="outline" render={<Link href="/" />}>Back to overview</Button>}
    />
  );
}
