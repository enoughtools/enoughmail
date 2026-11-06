import Foundation

@main struct MailNotificationDestinationChecks {
    static func main() throws {
        let message: [String: Any] = ["actorId": "actor", "organizationId": "org", "workspaceId": "workspace", "accountId": "account", "emailId": "email", "threadId": "thread"]
        var payload = message; payload["@type"] = "EmailDelivery"; payload["version"] = 1; payload["deploymentOrigin"] = "https://mail.example.com"
        let target = MailNotificationDestination(payload: payload)!
        let now = Date(timeIntervalSince1970: 100000)
        let pending = MailNotificationOpen(destination: target, now: now)
        func exposed(_ origin: String = "https://mail.example.com", _ actor: String = "actor", _ org: String = "org", _ workspace: String = "workspace", _ verified: Bool = true, _ date: Date? = nil) -> [String: String]? {
            pending.publicValue(origin: origin, actorId: actor, organizationId: org, workspaceId: workspace, verified: verified, now: date ?? now)
        }
        precondition(exposed()?["emailId"] == "email")
        precondition(exposed("https://other.example.com") == nil)
        precondition(exposed("https://mail.example.com", "other") == nil)
        precondition(exposed("https://mail.example.com", "actor", "other") == nil)
        precondition(exposed("https://mail.example.com", "actor", "org", "other") == nil)
        precondition(exposed("https://mail.example.com", "actor", "org", "workspace", false) == nil)
        precondition(exposed("https://mail.example.com", "actor", "org", "workspace", true, now.addingTimeInterval(86400)) == nil)
        let restored = try JSONDecoder().decode(MailNotificationOpen.self, from: JSONEncoder().encode(pending))
        precondition(restored == pending)
        for origin in ["http://mail.example.com", "https://user:secret@mail.example.com", "https://mail.example.com/path", "https://mail.example.com?next=elsewhere", "https://mail.example.com#email", "https://mail.example.com:443"] {
            var changed = payload; changed["deploymentOrigin"] = origin
            precondition(MailNotificationDestination(payload: changed) == nil)
        }
        for invalid in ["", String(repeating: "x", count: 256), "email\nforeign"] {
            var changed = payload; changed["emailId"] = invalid
            precondition(MailNotificationDestination(payload: changed) == nil)
        }
        var changed = payload; changed["url"] = "https://other.example.com"
        precondition(MailNotificationDestination(payload: changed) == nil)
        changed = payload; changed["@type"] = "PushVerification"; precondition(MailNotificationDestination(payload: changed) == nil)
        changed = payload; changed.removeValue(forKey: "threadId"); precondition(MailNotificationDestination(payload: changed) != nil)
        for version: Any in [true, 1.5, 2, "1"] { changed = payload; changed["version"] = version; precondition(MailNotificationDestination(payload: changed) == nil) }
        var queue = MailNotificationOpenQueue()
        precondition(queue.recordTap(payload, now: now))
        let firstReceipt = queue.pending!.receiptId
        // Looking at status or cancelling a dirty-draft prompt never consumes the tap.
        for _ in 0..<3 {
            precondition(queue.value(origin: target.origin, actorId: "actor", organizationId: "org", workspaceId: "workspace", verified: true, now: now)?["receiptId"] == firstReceipt)
        }
        var cold = MailNotificationOpenQueue(persisted: queue.persisted, now: now)
        precondition(cold.pending?.receiptId == firstReceipt)
        precondition(cold.value(origin: target.origin, actorId: "actor", organizationId: "org", workspaceId: "workspace", verified: false, now: now) == nil)
        precondition(!cold.acknowledge(firstReceipt, origin: target.origin, actorId: "other", organizationId: "org", workspaceId: "workspace", verified: true, now: now))
        precondition(!cold.acknowledge(UUID().uuidString, origin: target.origin, actorId: "actor", organizationId: "org", workspaceId: "workspace", verified: true, now: now))
        precondition(cold.pending?.receiptId == firstReceipt)
        precondition(cold.recordTap(payload, now: now))
        precondition(!cold.acknowledge(firstReceipt, origin: target.origin, actorId: "actor", organizationId: "org", workspaceId: "workspace", verified: true, now: now))
        precondition(cold.acknowledge(cold.pending!.receiptId, origin: target.origin, actorId: "actor", organizationId: "org", workspaceId: "workspace", verified: true, now: now))
        precondition(cold.pending == nil && cold.persisted == nil)
        precondition(MailNotificationOpenQueue(persisted: queue.persisted, now: now.addingTimeInterval(86400)).pending == nil)
        queue.clear(); precondition(queue.pending == nil)
        print("Mail notification destination checks passed")
    }
}
