import Foundation
import CoreFoundation

enum MailConnectionAction: String { case signOut, changeDeployment }
enum MailConnectionPolicy {
    static func action(body: Any, document: URL?, host: String, frameProtocol: String,
                       frameHost: String, framePort: Int, isMainFrame: Bool,
                       isActiveView: Bool) -> MailConnectionAction? {
        guard isActiveView, isMainFrame, frameProtocol == "https", frameHost == host,
              [0, 443].contains(framePort), let document,
              document.scheme == "https", document.host == host,
              document.port == nil || document.port == 443,
              document.path == "/apps/mail" || document.path.hasPrefix("/apps/mail/"),
              let body = body as? [String: Any], Set(body.keys) == ["version", "action"],
              let version = body["version"] as? NSNumber,
              CFGetTypeID(version) != CFBooleanGetTypeID(), version == 1,
              let raw = body["action"] as? String else { return nil }
        return MailConnectionAction(rawValue: raw)
    }
}
#if os(macOS)
enum MailCommand: String, CaseIterable {
    case newMessage, inbox, drafts, refresh, backToMessages, saveAndClose
}

enum MailCommandPolicy {
    static func isMailDocument(_ url: URL, host: String) -> Bool {
        url.scheme == "https" && url.host == host && (url.port == nil || url.port == 443)
            && (url.path == "/apps/mail" || url.path.hasPrefix("/apps/mail/"))
    }
    static func availability(body: Any, document: URL?, host: String, frameProtocol: String,
                             frameHost: String, framePort: Int, isMainFrame: Bool,
                             isActiveView: Bool) -> Set<MailCommand>? {
        guard isActiveView, isMainFrame, frameProtocol == "https", frameHost == host,
              [0, 443].contains(framePort), let document, isMailDocument(document, host: host),
              let state = body as? [String: Any],
              let version = state["version"] as? NSNumber,
              CFGetTypeID(version) != CFBooleanGetTypeID(), version == 1,
              let raw = state["enabled"] as? [String], raw.count <= MailCommand.allCases.count,
              raw.allSatisfy({ MailCommand(rawValue: $0) != nil }) else { return nil }
        return Set(raw.compactMap(MailCommand.init(rawValue:)))
    }
}
#endif
