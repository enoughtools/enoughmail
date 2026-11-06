import Foundation

@main struct MailCommandChecks {
    static func main() {
        let valid: [String: Any] = ["version": 1, "enabled": ["newMessage", "drafts"]]
        func state(_ body: Any = valid, _ url: String = "https://mail.example.com/apps/mail/",
                   proto: String = "https", host: String = "mail.example.com", port: Int = 443,
                   main: Bool = true, active: Bool = true) -> Set<MailCommand>? {
            MailCommandPolicy.availability(body: body, document: URL(string: url),
                host: "mail.example.com", frameProtocol: proto, frameHost: host,
                framePort: port, isMainFrame: main, isActiveView: active)
        }
        precondition(state() == [.newMessage, .drafts])
        precondition(state(port: 0) == [.newMessage, .drafts])
        // Page availability is not transferable across views, frames or deployments.
        precondition(state(active: false) == nil)
        precondition(state(main: false) == nil)
        precondition(state(host: "mail.example.com.evil.test") == nil)
        precondition(state(host: "other.example.com") == nil)
        precondition(state(proto: "http") == nil)
        precondition(state(port: 8443) == nil)
        precondition(state(valid, "https://other.example.com/apps/mail/") == nil)
        precondition(state(valid, "http://mail.example.com/apps/mail/") == nil)
        precondition(state(valid, "https://mail.example.com:8443/apps/mail/") == nil)
        precondition(state(valid, "https://mail.example.com/apps/mailbox/") == nil)
        precondition(state(valid, "https://mail.example.com/cdn-cgi/access/login") == nil)
        // Malformed or newer contracts never enable guessed commands or mutations.
        precondition(state(["version": true, "enabled": ["newMessage"]]) == nil)
        precondition(state(["version": 2, "enabled": ["newMessage"]]) == nil)
        precondition(state(["version": 1, "enabled": ["send", "delete"]]) == nil)
        precondition(state(["version": 1, "enabled": [1]]) == nil)
        precondition(state(["version": 1]) == nil)
        precondition(state(["version": 1, "enabled": []]) == [])
        let json = try! JSONSerialization.jsonObject(with: Data("{\"version\":1,\"enabled\":[\"saveAndClose\"]}".utf8))
        precondition(state(json) == [.saveAndClose])
        print("Mail command boundary checks passed (20 cases)")
    }
}
