"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { EmptyState } from "@/components/data/empty-state";
import { Button } from "@/components/ui/button";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  const forbidden = error.name === "ForbiddenError";
  return (
    <EmptyState
      icon={AlertTriangle}
      title={forbidden ? "You don't have permission to do that" : "Something went wrong loading this page"}
      description={
        forbidden
          ? error.message
          : "The error has been logged. Try again; if it keeps happening, note the reference below and let the team know."
      }
      action={
        <div className="flex flex-col items-center gap-2">
          <Button variant="outline" onClick={reset}>Try again</Button>
          {error.digest && <span className="font-mono text-[11px] text-muted-foreground">ref {error.digest}</span>}
        </div>
      }
    />
  );
}
