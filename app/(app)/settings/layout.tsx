import { SettingsTabs } from "./settings-tabs";
import { PageHeader } from "@/components/layout/page-header";

export default function SettingsLayout({ children }: LayoutProps<"/settings">) {
  return (
    <>
      <PageHeader title="Settings" description="Organisation preferences, your team, and connected subscription platforms." />
      <SettingsTabs />
      <div>{children}</div>
    </>
  );
}
