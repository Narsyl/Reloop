import { requireOrg } from "@/lib/auth/tenancy";
import { listTeam } from "@/lib/domain/queries/settings";
import { formatDate, initials } from "@/lib/format";
import { SectionHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata = { title: "Team" };

const ROLE_DESCRIPTIONS: Record<string, string> = {
  OWNER: "Full control, including billing and deleting the organisation.",
  ADMIN: "Manage integrations, rules, markers and settings.",
  OPERATOR: "Run day-to-day operations: resolve exceptions, retry actions.",
  VIEWER: "Read-only access.",
};

export default async function TeamPage() {
  const ctx = await requireOrg();
  const members = await listTeam(ctx);
  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <SectionHeader title="Members" description={`${members.length} ${members.length === 1 ? "person has" : "people have"} access to ${ctx.organizationName}.`} />
        <Button variant="outline" disabled title="Invitations arrive in a later phase">
          Invite member
        </Button>
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Joined</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((m) => (
              <TableRow key={m.id}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <span className="flex size-8 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                      {initials(m.user.name || m.user.email)}
                    </span>
                    <div>
                      <div className="text-sm font-medium">
                        {m.user.name}
                        {m.userId === ctx.userId && <span className="ml-2 text-xs text-muted-foreground">(you)</span>}
                      </div>
                      <div className="text-xs text-muted-foreground">{m.user.email}</div>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="text-sm capitalize">{m.role.toLowerCase()}</div>
                  <div className="text-xs text-muted-foreground">{ROLE_DESCRIPTIONS[m.role]}</div>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{formatDate(m.createdAt, ctx.timezone)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">Invitations and role changes are coming in a later phase. Roles are already enforced server-side.</p>
    </div>
  );
}
