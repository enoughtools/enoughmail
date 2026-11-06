import WebKit

@MainActor final class MailConnectionHandler: NSObject, WKScriptMessageHandler {
    private weak var model: ConnectionModel?
    init(_ model: ConnectionModel) { self.model = model }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let model, !model.busy, !model.validating, !model.settings,
              let deployment = model.active?.deployment,
              let action = MailConnectionPolicy.action(body: message.body,
                document: message.frameInfo.request.url, host: deployment.host,
                frameProtocol: message.frameInfo.securityOrigin.protocol,
                frameHost: message.frameInfo.securityOrigin.host,
                framePort: message.frameInfo.securityOrigin.port,
                isMainFrame: message.frameInfo.isMainFrame,
                isActiveView: message.webView === model.webView) else { return }
        switch action {
        case .signOut: model.signOut()
        case .changeDeployment: model.switchDeployment()
        }
    }
}
#if os(macOS)
// This bridge carries UI availability only; Mail retains all command validation.
@MainActor final class MailCommandHandler: NSObject, WKScriptMessageHandler {
    private weak var model: ConnectionModel?
    init(_ model: ConnectionModel) { self.model = model }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let model,
              let deployment = model.active?.deployment,
              let enabled = MailCommandPolicy.availability(body: message.body,
                document: message.frameInfo.request.url, host: deployment.host,
                frameProtocol: message.frameInfo.securityOrigin.protocol,
                frameHost: message.frameInfo.securityOrigin.host,
                framePort: message.frameInfo.securityOrigin.port,
                isMainFrame: message.frameInfo.isMainFrame,
                isActiveView: message.webView === model.webView) else { return }
        model.enabledMailCommands = enabled
    }
}

extension ConnectionModel {
    func isMailDocument(_ url: URL) -> Bool {
        guard let deployment = active?.deployment else { return false }
        return MailCommandPolicy.isMailDocument(url, host: deployment.host)
    }
    func canPerform(_ command: MailCommand) -> Bool {
        !busy && !validating && !settings && enabledMailCommands.contains(command)
            && webView?.url.map(isMailDocument) == true
    }
    func perform(_ command: MailCommand) {
        guard canPerform(command), let web = webView else { return }
        enabledMailCommands = []
        // Command names are fixed enum literals, never page input or user content.
        let script = "window.enoughMailNative?.version === 1 ? window.enoughMailNative.perform('\(command.rawValue)') : false"
        web.evaluateJavaScript(script) { [weak self, weak web] result, error in
            guard let self, self.webView === web else { return }
            if error != nil || result as? Bool != true { self.enabledMailCommands = [] }
        }
    }
}
#endif
