import Foundation
@main struct MailConnectionChecks {
    static func main() {
        let url = URL(string: "https://mail.example.com/apps/mail/")!
        func parse(_ body: Any, document: URL? = url, host: String = "mail.example.com", frameProtocol: String = "https", frameHost: String = "mail.example.com", framePort: Int = 443, main: Bool = true, active: Bool = true) -> MailConnectionAction? {
            MailConnectionPolicy.action(body: body, document: document, host: host, frameProtocol: frameProtocol, frameHost: frameHost, framePort: framePort, isMainFrame: main, isActiveView: active)
        }
        let message: [String: Any] = ["version": 1, "action": "signOut"]
        precondition(parse(message) == .signOut)
        precondition(parse(["version": 1, "action": "changeDeployment"]) == .changeDeployment)
        precondition(parse(message, framePort: 0) == .signOut)
        for body: Any in [[:], ["version": true, "action": "signOut"], ["version": 2, "action": "signOut"], ["version": 1, "action": "deleteMailbox"], ["version": 1, "action": "signOut", "token": "unexpected"], ["version": "1", "action": "signOut"]] { precondition(parse(body) == nil) }
        precondition(parse(message, main: false) == nil)
        precondition(parse(message, active: false) == nil)
        precondition(parse(message, document: nil) == nil)
        precondition(parse(message, frameProtocol: "http") == nil)
        precondition(parse(message, frameHost: "foreign.example.com") == nil)
        precondition(parse(message, framePort: 8443) == nil)
        for value in ["https://foreign.example.com/apps/mail/", "http://mail.example.com/apps/mail/", "https://mail.example.com:8443/apps/mail/", "https://mail.example.com/apps/mailbox", "https://mail.example.com/apps/docs/"] { precondition(parse(message, document: URL(string: value)!) == nil) }
        print("Mail connection bridge checks passed: 20 trusted-frame, action, version and scope cases.")
    }
}
