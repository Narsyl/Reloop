/**
 * Loose Zod schemas for the few Shopify Admin GraphQL shapes we rely on. Unknown fields pass through;
 * anything we depend on is validated so a contract change surfaces as SCHEMA_ERROR, never as a silent
 * wrong value.
 */
import { z } from "zod";

export const userErrorsSchema = z.array(z.object({ field: z.array(z.string().nullable()).nullable().optional(), message: z.string() }));

export const shopSchema = z.object({
  shop: z.object({
    id: z.string(),
    name: z.string(),
    myshopifyDomain: z.string(),
    primaryDomain: z.object({ host: z.string().nullable().optional() }).nullable().optional(),
    currencyCode: z.string(),
    plan: z.object({ displayName: z.string().nullable().optional() }).nullable().optional(),
    ianaTimezone: z.string().nullable().optional(),
  }),
});

export const accessScopesSchema = z.object({
  currentAppInstallation: z.object({ accessScopes: z.array(z.object({ handle: z.string() })) }),
});

export const publicationsSchema = z.object({
  publications: z.object({ nodes: z.array(z.object({ id: z.string(), name: z.string().nullable().optional(), catalog: z.object({ title: z.string().nullable().optional() }).nullable().optional() })) }),
});

export const variantNodeSchema = z.object({
  id: z.string(),
  title: z.string().nullable().optional(),
  sku: z.string().nullable().optional(),
  price: z.union([z.string(), z.number()]),
  inventoryItem: z.object({ id: z.string().nullable().optional(), tracked: z.boolean().nullable().optional(), requiresShipping: z.boolean().nullable().optional() }).nullable().optional(),
});

export const productNodeSchema = z.object({
  id: z.string(),
  title: z.string(),
  handle: z.string(),
  status: z.string(),
  productType: z.string().nullable().optional(),
  tags: z.array(z.string()).optional().default([]),
  vendor: z.string().nullable().optional(),
  onlineStoreUrl: z.string().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
  publishedOnPublication: z.boolean().optional(),
  variants: z.object({ nodes: z.array(variantNodeSchema) }),
});

export const productsSearchSchema = z.object({ products: z.object({ nodes: z.array(productNodeSchema) }) });
export const productByIdSchema = z.object({ product: productNodeSchema.nullable() });
export const variantProductSchema = z.object({ productVariant: z.object({ id: z.string(), product: productNodeSchema }).nullable() });

export const productCreateSchema = z.object({
  productCreate: z.object({ product: z.object({ id: z.string(), variants: z.object({ nodes: z.array(z.object({ id: z.string() })) }) }).nullable(), userErrors: userErrorsSchema }),
});
export const productUpdateSchema = z.object({ productUpdate: z.object({ product: z.object({ id: z.string() }).nullable(), userErrors: userErrorsSchema }) });
export const variantsBulkUpdateSchema = z.object({
  productVariantsBulkUpdate: z.object({ productVariants: z.array(z.object({ id: z.string(), sku: z.string().nullable().optional(), price: z.union([z.string(), z.number()]).optional() })).nullable(), userErrors: userErrorsSchema }),
});
export const publishSchema = z.object({ publishablePublish: z.object({ userErrors: userErrorsSchema }) });
