import { redirect } from "next/navigation";

/** The exceptions inbox now lives inside Activity as the Needs attention view. */
export default function ExceptionsPage() {
  redirect("/activity?view=attention");
}
