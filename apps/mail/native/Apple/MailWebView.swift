import SwiftUI
import WebKit
#if os(iOS)
import UIKit
#else
import AppKit
#endif

@MainActor final class MailWebCoordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    let model: ConnectionModel
    private var downloads: [ObjectIdentifier: URL] = [:]
    init(_ model: ConnectionModel) { self.model = model }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        #if os(macOS)
        model.enabledMailCommands = []
        #endif
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        // Message frames (srcdoc/about) are rendered by the Mail sanitizer.
        if action.targetFrame?.isMainFrame == false { decisionHandler(.allow); return }
        if url.scheme == "blob", action.shouldPerformDownload { decisionHandler(.download); return }
        guard let deployment = model.active?.deployment else { decisionHandler(.cancel); return }
        if url.scheme == "https", url.host == deployment.host, url.port == nil || url.port == 443 {
            if let saved = model.active, saved.persistent, !SavedSession.isNativeAppPath(url.path) {
                decisionHandler(.cancel)
                if (url.path == "/apps/mail" || url.path.hasPrefix("/apps/mail/")), !url.path.hasPrefix("/apps/mail/native/") {
                    var redirected = action.request
                    redirected.url = saved.appURL(url.path + (url.query.map { "?" + $0 } ?? "") + (url.fragment.map { "#" + $0 } ?? ""))
                    webView.load(redirected)
                } else if url.path.hasPrefix("/cdn-cgi/access/logout") { model.signOut() }
                else if action.navigationType == .linkActivated {
                    #if os(iOS)
                    UIApplication.shared.open(url)
                    #else
                    NSWorkspace.shared.open(url)
                    #endif
                }
                return
            }
            if url.path.hasPrefix("/cdn-cgi/access/") { decisionHandler(.cancel); model.expire(); return }
            decisionHandler(action.shouldPerformDownload ? .download : .allow); return
        }
        decisionHandler(.cancel)
        // Identity provider redirects never run inside an embedded web view.
        if action.navigationType == .linkActivated, ["https", "http", "mailto"].contains(url.scheme ?? "") {
            #if os(iOS)
            UIApplication.shared.open(url)
            #else
            NSWorkspace.shared.open(url)
            #endif
        } else if model.active?.persistent != true && (url.host?.hasSuffix("cloudflareaccess.com") == true || url.host == "accounts.google.com") { model.expire() }
    }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if let r = response.response as? HTTPURLResponse, [401, 403].contains(r.statusCode), response.isForMainFrame { decisionHandler(.cancel); model.expire(); return }
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }
    private func failed(_ error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        model.error = model.friendly(error)
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { model.error = "Mail stopped unexpectedly. Retry to reopen your mailbox. Saved cloud drafts are retained." }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if action.targetFrame == nil { webView.load(action.request) }; return nil
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        #if os(macOS)
        let alert = NSAlert(); alert.messageText = "EnoughMail"; alert.informativeText = message; alert.runModal(); completionHandler()
        #else
        let alert = UIAlertController(title: "EnoughMail", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() }); present(alert)
        #endif
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        #if os(macOS)
        let alert = NSAlert(); alert.messageText = "EnoughMail"; alert.informativeText = message; alert.addButton(withTitle: "Continue"); alert.addButton(withTitle: "Cancel"); completionHandler(alert.runModal() == .alertFirstButtonReturn)
        #else
        let alert = UIAlertController(title: "EnoughMail", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Continue", style: .default) { _ in completionHandler(true) }); alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) }); present(alert)
        #endif
    }
    #if os(iOS)
    private func present(_ controller: UIViewController) {
        let root = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first(where: \.isKeyWindow)?.rootViewController
        var current = root; while let child = current?.presentedViewController { current = child }; current?.present(controller, animated: true)
    }
    #else
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel(); panel.canChooseFiles = true; panel.canChooseDirectories = parameters.allowsDirectories; panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.begin { response in completionHandler(response == .OK ? panel.urls : nil) }
    }
    #endif
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let name = URL(fileURLWithPath: suggestedFilename).lastPathComponent
        #if os(macOS)
        let panel = NSSavePanel(); panel.nameFieldStringValue = name
        panel.begin { result in
            if result == .OK, let url = panel.url { self.downloads[ObjectIdentifier(download)] = url; completionHandler(url) } else { completionHandler(nil) }
        }
        #else
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("mail-" + UUID().uuidString)
        do { try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true); let url = directory.appendingPathComponent(name); downloads[ObjectIdentifier(download)] = url; completionHandler(url) }
        catch { completionHandler(nil); model.error = "The attachment could not be saved. Try again." }
        #endif
    }
    func downloadDidFinish(_ download: WKDownload) {
        guard let url = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        #if os(iOS)
        let share = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        share.popoverPresentationController?.sourceView = model.webView
        share.popoverPresentationController?.sourceRect = CGRect(x: 10, y: 10, width: 1, height: 1)
        share.completionWithItemsHandler = { _, _, _, _ in try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        present(share)
        #endif
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let url = downloads.removeValue(forKey: ObjectIdentifier(download))
        #if os(iOS)
        if let url { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        #endif
        model.error = "The attachment download failed. Reconnect and try again."
    }
}
#if os(iOS)
struct MailWebView: UIViewRepresentable {
    let view: WKWebView; @ObservedObject var model: ConnectionModel
    func makeCoordinator() -> MailWebCoordinator { MailWebCoordinator(model) }
    func makeUIView(context: Context) -> WKWebView { view.navigationDelegate = context.coordinator; view.uiDelegate = context.coordinator; return view }
    func updateUIView(_ uiView: WKWebView, context: Context) { uiView.isHidden = model.validating; uiView.isUserInteractionEnabled = !model.validating }
}
#else
struct MailWebView: NSViewRepresentable {
    let view: WKWebView; @ObservedObject var model: ConnectionModel
    func makeCoordinator() -> MailWebCoordinator { MailWebCoordinator(model) }
    func makeNSView(context: Context) -> WKWebView { view.navigationDelegate = context.coordinator; view.uiDelegate = context.coordinator; return view }
    func updateNSView(_ nsView: WKWebView, context: Context) { nsView.isHidden = model.validating }
}
#endif
