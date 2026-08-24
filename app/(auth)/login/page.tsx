"use client";

import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState } from "react";
import relooplogo from "@/app/relooplogo-trimmed.png";
import { signIn } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const res = await signIn.email({ email, password });
    setLoading(false);
    if (res.error) {
      setError(res.error.message ?? "Sign in failed. Check your email and password.");
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <div className="rounded-lg bg-card px-8 py-9 shadow-[0_15px_35px_rgba(60,66,87,0.08),0_5px_15px_rgba(0,0,0,0.10)] ring-1 ring-black/5 sm:px-11 sm:py-11 dark:ring-border">
      <div className="mb-7 flex justify-center">
        <Image src={relooplogo} alt="Reloop" className="h-9 w-auto object-contain" priority />
      </div>
      <h1 className="mb-6 text-center text-xl font-semibold tracking-tight">Sign in to your account</h1>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && (
          <p role="alert" className="rounded-md bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
            {error}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      <hr className="my-6 border-border" />
      <p className="text-center text-sm text-muted-foreground">
        New to Reloop?{" "}
        <Link href="/signup" className="font-medium text-primary underline-offset-4 hover:underline">
          Create account
        </Link>
      </p>
    </div>
  );
}
