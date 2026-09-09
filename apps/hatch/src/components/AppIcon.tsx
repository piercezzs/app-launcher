import { AppWindow } from "@tessera/ui";
import type { LauncherApp } from "../types";

interface AppIconProps {
  readonly app: LauncherApp;
  readonly size?: "small" | "medium" | "large";
}

export function AppIcon({ app, size = "medium" }: AppIconProps) {
  const className = `native-app-icon native-app-icon--${size}`;

  if (app.icon) {
    return <img className={className} src={app.icon} alt="" loading="lazy" />;
  }

  return (
    <span className={`${className} native-app-icon--placeholder`} aria-hidden="true">
      <AppWindow />
    </span>
  );
}
