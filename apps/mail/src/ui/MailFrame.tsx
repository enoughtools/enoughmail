import { AppFrame, type AppFrameProps } from '@open-cloud/ui';
import { TooltipProvider } from '@rebnz/enough-ui/tooltip';
import { Toaster } from '@rebnz/enough-ui/sonner';

/** Mail uses the workspace shell only when built for the integrated stack. */
export default function MailFrame(props: AppFrameProps) {
  const children = <TooltipProvider delayDuration={300}>{props.children}<Toaster position="bottom-right" closeButton /></TooltipProvider>;
  if (import.meta.env.MODE !== 'standalone') return <AppFrame {...props}>{children}</AppFrame>;
  return <div className="mail-standalone">
    <a className="oc-skip-link" href="#main">Skip to content</a>
    {children}
  </div>;
}
