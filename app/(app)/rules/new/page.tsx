import { redirect } from "next/navigation";

/** Rules are legacy configuration; milestones are configured on reusable reward schedules. */
export default function NewRulePage() {
  redirect("/rewards");
}
