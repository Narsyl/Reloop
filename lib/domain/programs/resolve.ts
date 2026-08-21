import "server-only";
import { dbFor } from "@/lib/db/tenant";

/**
 * Program resolution: (external product id, external variant id) → at most ONE
 * SubscriptionProgram.
 *
 * The database trigger (migration phase2_sync_orders_mapping_guard) guarantees a
 * product has either one "all variants" mapping or only variant-specific
 * mappings. This resolver still checks for ambiguity defensively and throws
 * rather than picking — ambiguity is a bug to surface, never a tie to break.
 */

export type ProgramResolution = {
  programId: string;
  productId: string;
  variantId: string | null;
  via: "ALL_VARIANTS" | "VARIANT";
};

export type ResolutionFailure = { reason: "UNKNOWN_PRODUCT" | "UNKNOWN_VARIANT" | "UNMAPPED"; productId: string | null; variantId: string | null };

export class AmbiguousProgramMappingError extends Error {
  constructor(public readonly productId: string, public readonly variantId: string | null, public readonly programIds: string[]) {
    super(`Ambiguous program mapping for product ${productId}${variantId ? ` variant ${variantId}` : ""}: ${programIds.join(", ")}`);
    this.name = "AmbiguousProgramMappingError";
  }
}

export type ProgramResolver = {
  resolve(externalProductId: string, externalVariantId: string | null): ProgramResolution | ResolutionFailure;
  /** Product/variant internal ids for an external pair, even when unmapped (used to link subscriptions to catalogue rows). */
  catalogue(externalProductId: string, externalVariantId: string | null): { productId: string | null; variantId: string | null };
  readonly productCount: number;
  readonly mappingCount: number;
};

export function isResolved(r: ProgramResolution | ResolutionFailure): r is ProgramResolution {
  return "programId" in r;
}

/**
 * Loads the organisation's catalogue + mappings once (catalogues are small) and
 * returns a synchronous resolver for bulk use (sync, recalculation).
 */
export async function buildProgramResolver(ctx: { organizationId: string }, integrationId: string): Promise<ProgramResolver> {
  const db = dbFor(ctx);
  const [products, mappings] = await Promise.all([
    db.product.findMany({
      where: { integrationId },
      select: { id: true, externalProductId: true, variants: { select: { id: true, externalVariantId: true } } },
    }),
    db.subscriptionProgramProduct.findMany({
      where: { program: { active: true } },
      select: { id: true, programId: true, productId: true, variantId: true, variantScope: true },
    }),
  ]);

  const productByExternal = new Map<string, { id: string; variants: Map<string, string> }>();
  for (const p of products) {
    productByExternal.set(p.externalProductId, { id: p.id, variants: new Map(p.variants.map((v) => [v.externalVariantId, v.id])) });
  }
  const mappingsByProduct = new Map<string, { all: string[]; byVariant: Map<string, string[]> }>();
  for (const m of mappings) {
    let entry = mappingsByProduct.get(m.productId);
    if (!entry) {
      entry = { all: [], byVariant: new Map() };
      mappingsByProduct.set(m.productId, entry);
    }
    if (m.variantScope === "*" || !m.variantId) entry.all.push(m.programId);
    else {
      const list = entry.byVariant.get(m.variantId) ?? [];
      list.push(m.programId);
      entry.byVariant.set(m.variantId, list);
    }
  }

  return {
    productCount: products.length,
    mappingCount: mappings.length,
    catalogue(externalProductId, externalVariantId) {
      const p = productByExternal.get(externalProductId);
      if (!p) return { productId: null, variantId: null };
      return { productId: p.id, variantId: externalVariantId ? (p.variants.get(externalVariantId) ?? null) : null };
    },
    resolve(externalProductId, externalVariantId) {
      const p = productByExternal.get(externalProductId);
      if (!p) return { reason: "UNKNOWN_PRODUCT", productId: null, variantId: null };
      const variantId = externalVariantId ? (p.variants.get(externalVariantId) ?? null) : null;
      const entry = mappingsByProduct.get(p.id);
      if (!entry) return { reason: "UNMAPPED", productId: p.id, variantId };
      const candidates: { programId: string; via: "ALL_VARIANTS" | "VARIANT" }[] = [];
      for (const programId of entry.all) candidates.push({ programId, via: "ALL_VARIANTS" });
      if (variantId) for (const programId of entry.byVariant.get(variantId) ?? []) candidates.push({ programId, via: "VARIANT" });
      const distinct = [...new Set(candidates.map((c) => c.programId))];
      if (distinct.length > 1) throw new AmbiguousProgramMappingError(p.id, variantId, distinct);
      if (distinct.length === 0) {
        // product has only variant-level mappings, and this variant isn't one of them
        return { reason: variantId ? "UNMAPPED" : "UNKNOWN_VARIANT", productId: p.id, variantId };
      }
      return { programId: distinct[0], productId: p.id, variantId, via: candidates[0].via };
    },
  };
}
