import { SettingsTabs } from "./settings-tabs";
import { PageHeader } from "@/components/layout/page-header";

export default function SettingsLayout({ children }: LayoutProps<"/settings">) {
  return (
    <>
      <PageHeader title="Settings" description="Connections, programmes, your team and workspace preferences." />
      <SettingsTabs />
      <div>{children}</div>
    </>
  );
}
