import type { ReactNode } from "react";
import type { AppManifest, Principal } from "@open-cloud/contracts";
import { Button } from "@rebnz/enough-ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@rebnz/enough-ui/dropdown-menu";
import enoughToolsLogo from "../../../branding/assets/logos/enough-tools-ink.svg";

export interface AppFrameProps {
  children: ReactNode;
  currentApp?: Pick<AppManifest, "id" | "name">;
  user?: Principal | null;
  apps?: AppManifest[];
  className?: string;
  activePage?: "Files" | "Apps";
  layout?: "page" | "workspace";
  sidebar?: ReactNode;
  headerContent?: ReactNode;
  /** Products with their own toolbar can embed AppControls instead of the shell header. */
  headerMode?: "standard" | "embedded";
}

export interface AppControlsProps {
  currentApp?: Pick<AppManifest, "id" | "name">;
  user?: Principal | null;
  apps?: AppManifest[];
  activePage?: "Files" | "Apps";
  className?: string;
  showApps?: boolean;
  /** Pass null when the workspace description does not apply to this app. */
  accountDescription?: ReactNode;
  /** Additional EnoughUI DropdownMenu items, such as a product's sign-out action. */
  accountMenuItems?: ReactNode;
}

function LauncherIcon() {
  return <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
    {[5, 12, 19].flatMap((x) => [5, 12, 19].map((y) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.8" />))}
  </svg>;
}

function AccountIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" focusable="false">
    <circle cx="12" cy="8" r="3.5" /><path d="M5 21v-2a7 7 0 0 1 14 0v2" />
  </svg>;
}

function initials(user: Principal) {
  const parts = user.displayName.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts.at(-1)![0]}` : (parts[0] ?? user.email).slice(0, 2)).toUpperCase();
}

function providerLabel(provider: string) {
  if (provider === "cloudflare-access") return "Cloudflare Access";
  if (provider === "local") return "Local development";
  return provider;
}

export function AppControls({ currentApp, user, apps = [], activePage = "Files", className, showApps = true, accountDescription, accountMenuItems }: AppControlsProps) {
  return (
    <div className={["oc-app-controls", "oc-header-actions", className].filter(Boolean).join(" ")} role="group" aria-label="App controls">
      {showApps && <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="oc-header-button" aria-label="Open apps menu" title="Apps">
            <LauncherIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={8} className="oc-shell-menu oc-apps-menu">
          <DropdownMenuItem asChild><a href="/" aria-current={!currentApp && activePage === "Files" ? "page" : undefined}>All files</a></DropdownMenuItem>
          <DropdownMenuItem asChild><a href="/workspace/apps" aria-current={!currentApp && activePage === "Apps" ? "page" : undefined}>Workspace apps</a></DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Installed apps</DropdownMenuLabel>
          {apps.map((app) => <DropdownMenuItem asChild key={app.id}>
            <a href={`/apps/${app.id}/`} aria-current={currentApp?.id === app.id ? "page" : undefined}>
              <span className="oc-app-menu-icon" aria-hidden="true">{app.name.slice(0, 1)}</span>{app.name}
            </a>
          </DropdownMenuItem>)}
          {apps.length === 0 && <p className="oc-menu-note">No apps installed yet.</p>}
        </DropdownMenuContent>
      </DropdownMenu>}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="oc-header-button oc-account-button" aria-label={user ? `Open account menu for ${user.displayName}` : "Open account menu"} title="Account">
            {user ? <span aria-hidden="true">{initials(user)}</span> : <AccountIcon />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={8} className="oc-shell-menu oc-account-menu">
          <DropdownMenuLabel className="oc-account-details">
            <strong>{user?.displayName ?? "Workspace account"}</strong>
            {user && <span>{user.email}</span>}
            <span className="oc-account-provider">{user ? providerLabel(user.provider) : "Connecting to your identity…"}</span>
          </DropdownMenuLabel>
          {accountDescription !== null && <>
            <DropdownMenuSeparator />
            {accountDescription ?? <>
              <DropdownMenuLabel>Private workspace</DropdownMenuLabel>
              <p className="oc-menu-note">Workspace members share read and write access to files.</p>
            </>}
          </>}
          {accountMenuItems && <><DropdownMenuSeparator />{accountMenuItems}</>}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function AppFrame({ children, currentApp, user, apps = [], className, activePage = "Files", layout = "page", sidebar, headerContent, headerMode = "standard" }: AppFrameProps) {
  return (
    <div className={`oc-app-frame oc-layout-${layout}`}>
      <a className="oc-skip-link" href="#main">Skip to content</a>
      {headerMode === "standard" && <header className="oc-top-nav">
        <a className="oc-home-link" href="/" aria-label="Enough Tools home">
          <img src={enoughToolsLogo} alt="Enough Tools" className="oc-brand-logo" />
        </a>
        <div className="oc-header-content">
          {headerContent ?? (currentApp && <span className="oc-current-app">{currentApp.name}</span>)}
        </div>
        <AppControls currentApp={currentApp} user={user} apps={apps} activePage={activePage} />
      </header>}
      <div className="oc-frame-body">
        {layout === "workspace" && sidebar && <aside className="oc-sidebar" aria-label="Workspace navigation">{sidebar}</aside>}
        <main id="main" tabIndex={-1} className={["oc-main", className].filter(Boolean).join(" ")}>
          {children}
        </main>
      </div>
      {layout === "page" && <footer className="oc-footer">
        <span>Enough Tools</span>
        <span>Your tools. Your cloud.</span>
      </footer>}
    </div>
  );
}
