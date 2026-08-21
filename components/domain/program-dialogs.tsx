"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Plus, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { assignProductToProgram, createProgram, removeProgramMapping } from "@/lib/domain/programs/actions";
import { ConfirmationDialog } from "@/components/domain/confirmation-dialog";

export function CreateProgramDialog({ disabled, trigger }: { disabled?: boolean; trigger?: React.ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit() {
    setError(null);
    start(async () => {
      const res = await createProgram({ name, description });
      if (!res.ok) return setError(res.fieldErrors?.name?.[0] ?? res.error);
      toast.success(`Program "${name}" created`);
      setOpen(false);
      setName("");
      setDescription("");
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<span className="contents" />}>{trigger ?? <Button disabled={disabled}><Plus data-icon="inline-start" /> New program</Button>}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New subscription program</DialogTitle>
          <DialogDescription>A program groups the products and variants that share one delivery-cycle journey — e.g. “Morning Magic Powder” for every size of the powder. Rules target programs, so you can change which products belong later without rebuilding rules.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="prog-name">Name</Label>
            <Input id="prog-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Morning Magic Powder" autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="prog-desc">Description <span className="text-muted-foreground">(optional, internal)</span></Label>
            <Textarea id="prog-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What counts as one continuous journey for this program." />
          </div>
          {error && <p role="alert" className="rounded-md bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
          <Button onClick={submit} disabled={pending || name.trim().length < 2}>{pending ? "Creating…" : "Create program"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type AssignableProduct = { id: string; title: string; variants: { id: string; title: string; sku: string | null; mappedTo: string | null }[]; allMappedTo: string | null };

export function AssignProductDialog({
  product,
  programs,
  trigger,
}: {
  product: AssignableProduct;
  programs: { id: string; name: string }[];
  trigger: React.ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [programId, setProgramId] = useState(programs[0]?.id ?? "");
  const [mode, setMode] = useState<"ALL" | "VARIANTS">(product.variants.some((v) => v.mappedTo) ? "VARIANTS" : "ALL");
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const unmappedVariants = product.variants.filter((v) => !v.mappedTo);

  function submit() {
    setError(null);
    start(async () => {
      const res = await assignProductToProgram({ programId, productId: product.id, variantIds: mode === "ALL" ? "ALL" : selected });
      if (!res.ok) return setError(res.error);
      toast.success("Mapped — journeys are being recalculated");
      setOpen(false);
      setSelected([]);
      router.refresh();
    });
  }

  const programName = programs.find((p) => p.id === programId)?.name ?? "";
  const selectCls = "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<span className="contents" />}>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Assign “{product.title}” to a program</DialogTitle>
          <DialogDescription>A product or variant can belong to exactly one program. Map all variants together when every size shares the same journey; map specific variants when they should track separately.</DialogDescription>
        </DialogHeader>
        {programs.length === 0 ? (
          <p className="text-sm text-muted-foreground">Create a subscription program first.</p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="assign-program">Program</Label>
              <select id="assign-program" className={selectCls} value={programId} onChange={(e) => setProgramId(e.target.value)}>
                {programs.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label>Which variants?</Label>
              <label className="flex items-start gap-2 text-sm">
                <input type="radio" name="mode" className="mt-1" checked={mode === "ALL"} onChange={() => setMode("ALL")} disabled={product.variants.some((v) => v.mappedTo) || !!product.allMappedTo} />
                <span>
                  All variants <span className="text-muted-foreground">(including any added later)</span>
                  {product.variants.some((v) => v.mappedTo) && <span className="block text-xs text-status-warning">Not available while variant-specific mappings exist — remove those first.</span>}
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input type="radio" name="mode" className="mt-1" checked={mode === "VARIANTS"} onChange={() => setMode("VARIANTS")} disabled={!!product.allMappedTo} />
                <span>
                  Specific variants
                  {product.allMappedTo && <span className="block text-xs text-status-warning">Not available while an all-variants mapping exists — remove it first.</span>}
                </span>
              </label>
              {mode === "VARIANTS" && (
                <ul className="ml-6 space-y-1">
                  {product.variants.map((v) => (
                    <li key={v.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        id={`v-${v.id}`}
                        disabled={!!v.mappedTo}
                        checked={selected.includes(v.id)}
                        onChange={(e) => setSelected((s) => (e.target.checked ? [...s, v.id] : s.filter((x) => x !== v.id)))}
                      />
                      <label htmlFor={`v-${v.id}`} className={v.mappedTo ? "text-muted-foreground" : ""}>
                        {v.title}
                        {v.sku && <span className="ml-1 font-mono text-[11px] text-muted-foreground">{v.sku}</span>}
                        {v.mappedTo && <span className="ml-2 text-xs text-muted-foreground">already in {v.mappedTo}</span>}
                      </label>
                    </li>
                  ))}
                  {unmappedVariants.length === 0 && <li className="text-xs text-muted-foreground">All variants are already mapped.</li>}
                </ul>
              )}
            </div>
            {programId && (
              <p className="rounded-md bg-surface px-3 py-2 text-xs text-muted-foreground">
                {mode === "ALL" ? `Every “${product.title}” subscription will count its deliveries in the “${programName}” journey.` : `${selected.length} selected variant${selected.length === 1 ? "" : "s"} of “${product.title}” will count deliveries in “${programName}”.`} Journeys are recalculated automatically after saving; nothing is written to Recharge.
              </p>
            )}
            {error && <p role="alert" className="rounded-md bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{error}</p>}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
          <Button onClick={submit} disabled={pending || programs.length === 0 || !programId || (mode === "VARIANTS" && selected.length === 0) || (mode === "ALL" && !!product.allMappedTo)}>
            {pending ? "Saving…" : "Save mapping"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RemoveMappingButton({ mappingId, label }: { mappingId: string; label: string }) {
  const router = useRouter();
  return (
    <ConfirmationDialog
      trigger={<button type="button" className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Remove ${label}`}><X className="size-3.5" /></button>}
      title="Remove this mapping?"
      impact={`${label} will no longer belong to this program. Affected subscriptions become unmapped (or move journeys if another mapping applies) and their journeys are recalculated. Nothing is written to Recharge.`}
      confirmLabel="Remove mapping"
      destructive
      onConfirm={async () => {
        const r = await removeProgramMapping(mappingId);
        if (r.ok) router.refresh();
        return r;
      }}
      successMessage="Mapping removed — recalculating journeys"
    />
  );
}
