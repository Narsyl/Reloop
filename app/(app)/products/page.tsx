import { redirect } from "next/navigation";

/** Programmes and products now live under Settings. */
export default function ProductsPage() {
  redirect("/settings/products");
}
