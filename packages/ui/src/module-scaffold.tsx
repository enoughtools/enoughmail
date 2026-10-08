import type { ReactNode } from "react";
import type { AppManifest, WorkspaceResource } from "@open-cloud/contracts";
import { Badge } from "@rebnz/enough-ui/badge";
import { Button } from "@rebnz/enough-ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@rebnz/enough-ui/card";
import { AppFrame } from "./app-frame";
import { useModuleContext } from "./use-module-context";

export interface ModuleScaffoldProps {
  manifest: AppManifest;
  preview?: ReactNode;
  children?: ReactNode;
  status?: string;
  roadmap?: Array<{ title: string; description: string }>;
  resource?: Pick<WorkspaceResource, "id" | "name">;
  previewTitle?: string;
  previewDescription?: string;
  previewFooter?: string;
}

const defaultRoadmap = [
  { title: "Application experience", description: "Replace this example with the workflows your organization needs." },
  { title: "Durable data", description: "Use shared workspace files and add app-specific data only when needed." },
  { title: "Shared resources", description: "Declare file handlers and embeds so other apps can open and display shared files." },
];

export function ModuleScaffold({ manifest, preview, children, status = "Scaffold", roadmap = defaultRoadmap, resource, previewTitle = "Example preview", previewDescription = "A starting point for the app and its embeddable view.", previewFooter = "Illustrative content only. Replace this view with a file handler or application workflow." }: ModuleScaffoldProps) {
  const context = useModuleContext(manifest.id);
  const appPath = `/apps/${manifest.id}/`;
  const embedPath = manifest.embeds[0]?.path ?? "/embed/";
  const embedRoute = `${appPath}${embedPath.replace(/^\//, "")}`;
  const resourceQuery = resource ? `?fileId=${encodeURIComponent(resource.id)}` : "";
  const embedHref = `${embedRoute}${resourceQuery}`;
  const isEmbed = window.location.pathname === embedRoute || window.location.pathname === embedRoute.replace(/\/$/, "");
  const example = preview ?? (
    <div className="oc-example-document">
      <p className="oc-example-label">Example content</p>
      <h2 className="oc-example-title">A place for your next idea</h2>
      <p className="oc-example-text">Build your application here. This preview demonstrates how a resource can appear inside another Enough Tools app.</p>
    </div>
  );

  if (isEmbed) {
    return (
      <main id="main" className="oc-embed" aria-label={`${resource?.name ?? manifest.name} preview`}>
        <div className="oc-embed-heading">
          <strong>{manifest.name}</strong>
          <Badge variant="outline">{status}</Badge>
          <a href={`${appPath}${resourceQuery}`} target="_top">Open {resource?.name ?? manifest.name} <span aria-hidden="true">↗</span></a>
        </div>
        {context.sessionError && <p className="oc-alert" role="alert">{context.sessionError}</p>}
        {example}
        <p className="oc-preview-footer">{previewFooter}</p>
      </main>
    );
  }

  const isRegistered = context.apps.some((app) => app.id === manifest.id);
  return (
    <AppFrame currentApp={manifest} user={context.user} apps={context.apps}>
      <section className="oc-page-heading" aria-labelledby="app-title">
        <div>
          <p className="oc-eyebrow">Your workspace / {manifest.name}</p>
          <h1 id="app-title" className="oc-title">{resource?.name ?? manifest.name}</h1>
          <p className="oc-lead">{resource ? `Opened with ${manifest.name} from your shared workspace.` : manifest.description}</p>
        </div>
        <Badge variant="outline" className="oc-scaffold-badge">{status}</Badge>
      </section>

      {(context.sessionError || context.registryError) && (
        <div className="oc-alert" role="alert">{context.sessionError ?? context.registryError}</div>
      )}

      <div className="oc-module-facts" aria-label="Application status">
        <div><span className="oc-fact-label">Workspace</span><strong>{context.loading ? "Checking connection…" : isRegistered ? "Registered app" : "Not registered"}</strong></div>
        <div><span className="oc-fact-label">Identity</span><strong>{context.loading ? "Checking session…" : context.user ? "Shared workspace identity" : "Session unavailable"}</strong></div>
        <div><span className="oc-fact-label">Data</span><strong>{resource ? "Workspace file" : status === "App overview" ? "No file selected" : "Example content only"}</strong></div>
      </div>

      <div className="oc-module-layout">
        <Card className="oc-preview-card">
          <CardHeader className="oc-preview-header">
            <div>
              <CardTitle>{previewTitle}</CardTitle>
              <CardDescription>{previewDescription}</CardDescription>
            </div>
            {(resource || status === "Scaffold") && <Button variant="outline" size="sm" asChild><a href={embedHref}>Open preview <span aria-hidden="true">↗</span></a></Button>}
          </CardHeader>
          <CardContent>{example}</CardContent>
          <p className="oc-preview-footer">{previewFooter}</p>
        </Card>
        <aside className="oc-module-sidebar">
          <h2 className="oc-section-title">A foundation to build on</h2>
          <p className="oc-muted">{resource ? `${manifest.name} is viewing a saved workspace file. Its features can grow around these shared files.` : `${manifest.name} is connected to your workspace. Build the workflows your organization needs here.`}</p>
          <ul className="oc-roadmap">
            {roadmap.map((item, index) => (
              <li key={item.title}>
                <span className="oc-step-number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                <div><h3>{item.title}</h3><p>{item.description}</p></div>
              </li>
            ))}
          </ul>
          <Button variant="ghost" size="ghost" asChild><a href="/">Back to files <span aria-hidden="true">→</span></a></Button>
        </aside>
      </div>
      {children && <section className="oc-module-extra">{children}</section>}
    </AppFrame>
  );
}
