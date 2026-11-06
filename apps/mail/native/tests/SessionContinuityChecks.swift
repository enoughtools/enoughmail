import Foundation
import WebKit
import AppKit

@MainActor private final class FixtureMailView: WKWebView {
    override var url: URL? { URL(string: "https://mail.example.com/apps/mail/") }
}

@main struct SessionContinuityChecks {
    @MainActor static func main() async throws {
        _ = NSApplication.shared
        func responseError(_ status: Int) -> Error {
            do { try SessionValidationPolicy.requireSuccessfulResponse(status); fatalError("Expected failure") }
            catch { return error }
        }
        try SessionValidationPolicy.requireSuccessfulResponse(200)
        for status in [401, 403] { precondition(responseError(status) is SessionAdmissionError) }
        for status in [302, 429, 500, 503] { precondition(!(responseError(status) is SessionAdmissionError)) }
        let saved = SavedSession(deployment: try Deployment.parse("mail.example.com"),
            session: MailSession(actorId: "fixture", organizationId: "fixture-org", workspaceId: "fixture-workspace"),
            token: "fixture-no-network-no-keychain")
        try SessionValidationPolicy.requireMatchingIdentity(saved.session, saved: saved.session)
        do {
            try SessionValidationPolicy.requireMatchingIdentity(MailSession(actorId: "", organizationId: "", workspaceId: ""), saved: saved.session)
            fatalError("Incomplete session must fail")
        } catch { precondition(!(error is SessionAdmissionError)) }
        do {
            try SessionValidationPolicy.requireMatchingIdentity(MailSession(actorId: "other", organizationId: "fixture-org", workspaceId: "fixture-workspace"), saved: saved.session)
            fatalError("Changed identity must fail")
        } catch { precondition(error is SessionAdmissionError) }
        var failure: Error? = nil
        let model = ConnectionModel(validationOverride: { _ in if let failure { throw failure } })
        let configuration = WKWebViewConfiguration(); configuration.websiteDataStore = .nonPersistent()
        let originalView = FixtureMailView(frame: .zero, configuration: configuration)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 300),
            styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = originalView
        model.active = saved; model.webView = originalView
        model.enabledMailCommands = [.newMessage]
        precondition(model.canPerform(.newMessage))
        func settle() async {
            for _ in 0..<100 {
                if model.sessionCheckState != .checking { return }
                try? await Task.sleep(for: .milliseconds(10))
            }
            fatalError("Session check did not settle")
        }
        for error in [URLError(.notConnectedToInternet), URLError(.networkConnectionLost),
                      responseError(503), responseError(302),
                      NSError(domain: NSCocoaErrorDomain, code: 4099)] as [Error] {
            precondition(window.makeFirstResponder(originalView))
            precondition(window.firstResponder === originalView)
            failure = error; model.foreground()
            precondition(model.sessionCheckState == .checking && model.validating)
            precondition(originalView.isHidden)
            precondition(!model.canPerform(.newMessage))
            precondition(window.firstResponder !== originalView)
            await settle()
            precondition(model.sessionCheckState == .suspended && model.validating)
            precondition(model.webView === originalView && model.active?.session == saved.session)
            precondition(originalView.isHidden)
            precondition(!model.canPerform(.newMessage))
            precondition(window.firstResponder !== originalView)
            precondition(model.validationError != nil)
            failure = nil; model.foreground(); await settle()
            precondition(model.sessionCheckState == .ready && !model.validating)
            precondition(model.webView === originalView && model.validationError == nil)
            precondition(!originalView.isHidden)
            precondition(model.canPerform(.newMessage))
        }
        for error in [responseError(401), responseError(403), SessionAdmissionError("identity changed")] {
            model.active = saved; model.webView = originalView; failure = error
            model.foreground(); await settle()
            precondition(model.webView == nil && model.active == nil)
        }
        model.active = saved; model.webView = originalView; originalView.isHidden = false
        precondition(window.makeFirstResponder(originalView))
        model.expire()
        precondition(originalView.isHidden && window.firstResponder !== originalView)
        precondition(model.webView == nil && model.active == nil)
        // Expiry invalidates the request ticket: even a late successful reply cannot restore the viewer.
        var reply: CheckedContinuation<Void, Error>?
        let waiting = ConnectionModel(validationOverride: { _ in
            try await withCheckedThrowingContinuation { reply = $0 }
        })
        waiting.active = saved; waiting.webView = originalView; waiting.foreground()
        while reply == nil { await Task.yield() }
        waiting.expire(); reply?.resume()
        for _ in 0..<10 { await Task.yield() }
        precondition(waiting.webView == nil && waiting.active == nil && !waiting.validating)
        print("Session continuity injected-error checks passed: HTTP admission/transient classification, five suspend/retry cases, identity rejection and late reply after expiry")
    }
}
