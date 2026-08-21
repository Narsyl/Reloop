"use client";

import { useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Confirmation for dangerous actions. Always explains the impact in a sentence
 * a non-technical operator understands. `confirmWord` forces typed confirmation
 * for destructive operations.
 */
export function ConfirmationDialog({
  trigger,
  title,
  impact,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  confirmWord,
  onConfirm,
  successMessage,
}: {
  trigger: ReactNode;
  title: ReactNode;
  impact: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  confirmWord?: string;
  onConfirm: () => Promise<{ ok: boolean; error?: string } | void>;
  successMessage?: string;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [pending, startTransition] = useTransition();
  const canConfirm = !confirmWord || typed.trim() === confirmWord;

  function run() {
    startTransition(async () => {
      const res = await onConfirm();
      if (res && res.ok === false) {
        toast.error(res.error ?? "Something went wrong.");
        return;
      }
      if (successMessage) toast.success(successMessage);
      setOpen(false);
      setTyped("");
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<span className="contents" />}>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="text-sm leading-relaxed text-foreground/80">{impact}</DialogDescription>
        </DialogHeader>
        {confirmWord && (
          <div className="space-y-1.5">
            <Label htmlFor="confirm-word" className="text-xs text-muted-foreground">
              Type <span className="font-mono font-semibold text-foreground">{confirmWord}</span> to confirm
            </Label>
            <Input id="confirm-word" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button variant={destructive ? "destructive" : "default"} onClick={run} disabled={pending || !canConfirm}>
            {pending ? "Working…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
