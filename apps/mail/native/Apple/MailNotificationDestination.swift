import Foundation
import CoreFoundation

/// A notification supplies a destination, never authority to read its contents.
struct MailNotificationDestination: Codable, Equatable {
    let origin: String
    let actorId: String
    let organizationId: String
    let workspaceId: String
    let accountId: String
    let emailId: String
    let threadId: String?

    init?(payload: [String: Any]) {
        guard payload["@type"] as? String == "EmailDelivery",
              let version = payload["version"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version.intValue == 1, version.doubleValue == 1,
              let origin = payload["deploymentOrigin"] as? String,
              let parts = URLComponents(string: origin), parts.scheme == "https", parts.host != nil,
              parts.user == nil, parts.password == nil, parts.port == nil,
              parts.path.isEmpty, parts.query == nil, parts.fragment == nil,
              parts.url?.absoluteString == origin,
              Set(payload.keys).isSubset(of: ["@type", "version", "deploymentOrigin", "actorId", "organizationId", "workspaceId", "accountId", "emailId", "threadId"]) else { return nil }
        func identifier(_ key: String) -> String? {
            guard let value = payload[key] as? String, !value.isEmpty, value.utf8.count <= 255,
                  !value.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else { return nil }
            return value
        }
        guard let actorId = identifier("actorId"), let organizationId = identifier("organizationId"),
              let workspaceId = identifier("workspaceId"), let accountId = identifier("accountId"),
              let emailId = identifier("emailId") else { return nil }
        let threadId = identifier("threadId")
        if payload["threadId"] != nil && threadId == nil { return nil }
        self.origin = origin; self.actorId = actorId; self.organizationId = organizationId
        self.workspaceId = workspaceId; self.accountId = accountId; self.emailId = emailId; self.threadId = threadId
    }
    func matches(origin: String, actorId: String, organizationId: String, workspaceId: String) -> Bool {
        self.origin == origin && self.actorId == actorId && self.organizationId == organizationId && self.workspaceId == workspaceId
    }
    var payload: [String: Any] {
        var value: [String: Any] = ["@type": "EmailDelivery", "version": 1, "deploymentOrigin": origin, "actorId": actorId, "organizationId": organizationId, "workspaceId": workspaceId, "accountId": accountId, "emailId": emailId]
        if let threadId { value["threadId"] = threadId }
        return value
    }
}

struct MailNotificationOpen: Codable, Equatable {
    let receiptId: String
    let queuedAt: Date
    let destination: MailNotificationDestination
    init(destination: MailNotificationDestination, now: Date = Date()) {
        receiptId = UUID().uuidString; queuedAt = now; self.destination = destination
    }
    func publicValue(origin: String, actorId: String, organizationId: String, workspaceId: String, verified: Bool, now: Date = Date()) -> [String: String]? {
        guard verified, UUID(uuidString: receiptId) != nil,
              MailNotificationDestination(payload: destination.payload) == destination,
              now >= queuedAt, now.timeIntervalSince(queuedAt) < 86400,
              destination.matches(origin: origin, actorId: actorId, organizationId: organizationId, workspaceId: workspaceId) else { return nil }
        var result = ["receiptId": receiptId, "accountId": destination.accountId, "emailId": destination.emailId]
        if let threadId = destination.threadId { result["threadId"] = threadId }
        return result
    }
}

struct MailNotificationOpenQueue {
    private(set) var pending: MailNotificationOpen?
    init(persisted: Data? = nil, now: Date = Date()) {
        guard let persisted, persisted.count <= 4096,
              let value = try? JSONDecoder().decode(MailNotificationOpen.self, from: persisted),
              UUID(uuidString: value.receiptId) != nil,
              MailNotificationDestination(payload: value.destination.payload) == value.destination,
              now >= value.queuedAt, now.timeIntervalSince(value.queuedAt) < 86400 else { return }
        pending = value
    }
    var persisted: Data? {
        guard let pending, let data = try? JSONEncoder().encode(pending), data.count <= 4096 else { return nil }
        return data
    }
    @discardableResult mutating func recordTap(_ payload: [String: Any], now: Date = Date()) -> Bool {
        guard let destination = MailNotificationDestination(payload: payload) else { return false }
        pending = MailNotificationOpen(destination: destination, now: now); return true
    }
    func value(origin: String, actorId: String, organizationId: String, workspaceId: String, verified: Bool, now: Date = Date()) -> [String: String]? {
        pending?.publicValue(origin: origin, actorId: actorId, organizationId: organizationId, workspaceId: workspaceId, verified: verified, now: now)
    }
    @discardableResult mutating func acknowledge(_ receiptId: String, origin: String, actorId: String, organizationId: String, workspaceId: String, verified: Bool, now: Date = Date()) -> Bool {
        guard value(origin: origin, actorId: actorId, organizationId: organizationId, workspaceId: workspaceId, verified: verified, now: now)?["receiptId"] == receiptId else { return false }
        pending = nil; return true
    }
    mutating func clear() { pending = nil }
}
