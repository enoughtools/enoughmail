#if os(iOS)
import UIKit
import UserNotifications
import WebKit

@MainActor final class MailPush: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    static let shared = MailPush()
    weak var model: ConnectionModel?
    private var token: String?
    private var registration: CheckedContinuation<String, Error>?
    private var timeout: Task<Void, Never>?
    private var verifications: [[String: String]] = []
    private var lastDelivery: [String: Double] = [:]
    private static let pendingKey = "enoughMail.pendingNotificationOpen.v1"
    private var pendingNavigation = MailNotificationOpenQueue(persisted: UserDefaults.standard.data(forKey: pendingKey))
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = Self.shared
        let mail = UNNotificationCategory(identifier: "ENOUGH_MAIL_MESSAGE", actions: [], intentIdentifiers: [], hiddenPreviewsBodyPlaceholder: "New email", options: [])
        UNUserNotificationCenter.current().setNotificationCategories([mail])
        return true
    }
    private var environment: String? {
        #if targetEnvironment(simulator)
        return "development"
        #else
        // The installed provisioning profile supplies Apple's actual push environment.
        // App Store installs omit the profile and always use production APNs.
        guard let path = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision") else { return "production" }
        guard let data = try? Data(contentsOf: path), data.count < 1024 * 1024,
              let start = data.range(of: Data("<?xml".utf8)), let end = data.range(of: Data("</plist>".utf8)), start.lowerBound < end.upperBound,
              let profile = try? PropertyListSerialization.propertyList(from: data.subdata(in: start.lowerBound..<end.upperBound), options: [], format: nil) as? [String: Any],
              let entitlements = profile["Entitlements"] as? [String: Any],
              let identifier = entitlements["application-identifier"] as? String,
              identifier.hasSuffix("." + (Bundle.main.bundleIdentifier ?? "invalid")) else { return nil }
        return entitlements["aps-environment"] as? String
        #endif
    }
    func request() async throws -> String {
        guard environment == "development" || environment == "production" else { throw ConnectionError.message("Apple push signing is unavailable in this build.") }
        let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
        guard granted else { throw ConnectionError.message("Notifications are blocked. Allow EnoughMail notifications in iPhone Settings, then try again.") }
        if let token { return token }
        guard registration == nil else { throw ConnectionError.message("Notification registration is already running.") }
        return try await withCheckedThrowingContinuation { continuation in
            registration = continuation
            timeout = Task { try? await Task.sleep(for: .seconds(20)); if !Task.isCancelled { finish(.failure(ConnectionError.message("Apple notification registration timed out. Try again."))) } }
            UIApplication.shared.registerForRemoteNotifications()
        }
    }
    private func finish(_ result: Result<String, Error>) { timeout?.cancel(); timeout = nil; let pending = registration; registration = nil; pending?.resume(with: result) }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken data: Data) {
        let value = data.map { String(format: "%02x", $0) }.joined()
        Self.shared.token = value; Self.shared.finish(.success(value))
    }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Self.shared.finish(.failure(ConnectionError.message("Apple notification registration failed. Reconnect and try again.")))
    }
    private func receive(_ info: [AnyHashable: Any], date: Date) {
        guard let value = info["enoughMail"] as? [String: Any], let origin = value["deploymentOrigin"] as? String,
              let url = URL(string: origin), url.scheme == "https", url.host != nil, url.absoluteString == origin else { return }
        if value["@type"] as? String == "PushVerification", let id = value["pushSubscriptionId"] as? String, UUID(uuidString: id) != nil,
           let code = value["verificationCode"] as? String, code.count == 32, code.allSatisfy({ $0.isHexDigit }) {
            guard !verifications.contains(where: { $0["id"] == id && $0["code"] == code }) else { return }
            verifications.removeAll { $0["id"] == id }; verifications.append(["id": id, "code": code, "origin": origin]); verifications = Array(verifications.suffix(20))
        } else if ["StateChange", "PushTest", "EmailDelivery"].contains(value["@type"] as? String ?? "") {
            guard date.timeIntervalSince1970 * 1000 > (lastDelivery[origin] ?? 0) else { return }
            lastDelivery[origin] = date.timeIntervalSince1970 * 1000
        }
        if let model, !model.validating, !model.busy, let saved = model.active, saved.deployment.origin.absoluteString == origin,
           let view = model.webView, let url = view.url, url.scheme == "https", url.host == saved.deployment.host,
           url.port == nil || url.port == 443, url.path == "/apps/mail" || url.path.hasPrefix("/apps/mail/") {
            view.evaluateJavaScript("window.dispatchEvent(new Event('mail-native-notifications'))", completionHandler: nil)
        }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completion: @escaping (UNNotificationPresentationOptions) -> Void) {
        Task { @MainActor in self.receive(notification.request.content.userInfo, date: notification.date); completion([.banner, .sound, .list]) }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completion: @escaping () -> Void) {
        Task { @MainActor in
            self.receive(response.notification.request.content.userInfo, date: response.notification.date)
            // Passive receipt and delivered-notification enumeration never navigate.
            if response.actionIdentifier == UNNotificationDefaultActionIdentifier,
               let payload = response.notification.request.content.userInfo["enoughMail"] as? [String: Any],
               self.pendingNavigation.recordTap(payload) {
                self.persistPendingMessage()
                self.wakePendingMessage()
            }
            completion()
        }
    }
    private func persistPendingMessage() {
        if let data = pendingNavigation.persisted {
            UserDefaults.standard.set(data, forKey: Self.pendingKey)
        } else { UserDefaults.standard.removeObject(forKey: Self.pendingKey) }
    }
    func pendingValue(_ saved: SavedSession, verified: Bool) -> [String: String]? {
        pendingNavigation.value(origin: saved.deployment.origin.absoluteString, actorId: saved.session.actorId, organizationId: saved.session.organizationId, workspaceId: saved.session.workspaceId, verified: verified)
    }
    func acknowledgeOpen(_ receiptId: String, saved: SavedSession, verified: Bool) -> Bool {
        guard pendingNavigation.acknowledge(receiptId, origin: saved.deployment.origin.absoluteString, actorId: saved.session.actorId, organizationId: saved.session.organizationId, workspaceId: saved.session.workspaceId, verified: verified) else { return false }
        persistPendingMessage(); return true
    }
    func wakePendingMessage() {
        guard let model, !model.validating, !model.busy, let saved = model.active,
              pendingValue(saved, verified: true) != nil, let view = model.webView,
              let url = view.url, url.scheme == "https", url.host == saved.deployment.host,
              url.port == nil || url.port == 443, url.path == "/apps/mail" || url.path.hasPrefix("/apps/mail/") else { return }
        view.evaluateJavaScript("window.dispatchEvent(new Event('mail-native-notification-open'))", completionHandler: nil)
    }
    func status(saved: SavedSession) async -> [String: Any] {
        let origin = saved.deployment.origin.absoluteString
        // Delivered notifications also recover setup after a cold launch.
        for item in await UNUserNotificationCenter.current().deliveredNotifications() { receive(item.request.content.userInfo, date: item.date) }
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        let permission = settings.authorizationStatus == .denied ? "denied" : settings.authorizationStatus == .notDetermined ? "default" : "granted"
        return ["permission": permission, "environment": environment ?? "unavailable", "deviceToken": token ?? NSNull(), "verifications": verifications.filter { $0["origin"] == origin }, "lastDeliveryAt": lastDelivery[origin] ?? 0, "pendingMessage": pendingValue(saved, verified: true) as Any? ?? NSNull()]
    }
    func stop() {
        finish(.failure(CancellationError())); token = nil; verifications = []; lastDelivery = [:]
        pendingNavigation.clear(); persistPendingMessage()
        UIApplication.shared.unregisterForRemoteNotifications()
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
    }
}

@MainActor final class MailPushHandler: NSObject, WKScriptMessageHandlerWithReply {
    private weak var model: ConnectionModel?
    init(_ model: ConnectionModel) { self.model = model }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard let model, !model.busy, !model.validating, let saved = model.active,
              let body = message.body as? [String: Any], let action = body["action"] as? String,
              ["status", "register", "stop", "acknowledgeOpen"].contains(action),
              Set(body.keys) == (action == "acknowledgeOpen" ? ["version", "action", "receiptId"] : ["version", "action"]),
              MailConnectionPolicy.action(body: ["version": body["version"] as Any, "action": "signOut"], document: message.frameInfo.request.url, host: saved.deployment.host,
                frameProtocol: message.frameInfo.securityOrigin.protocol, frameHost: message.frameInfo.securityOrigin.host, framePort: message.frameInfo.securityOrigin.port,
                isMainFrame: message.frameInfo.isMainFrame, isActiveView: message.webView === model.webView) != nil else { replyHandler(nil, "The Mail connection is unavailable."); return }
        Task { [weak model, weak view = message.webView] in
            do {
                if action == "register" { _ = try await MailPush.shared.request() }
                if action == "stop" { MailPush.shared.stop() }
                guard let model, model.webView === view, model.active?.session == saved.session, model.active?.deployment == saved.deployment, !model.validating, !model.busy else { replyHandler(nil, "The Mail connection changed."); return }
                if action == "acknowledgeOpen" {
                    guard let receiptId = body["receiptId"] as? String, UUID(uuidString: receiptId) != nil,
                          MailPush.shared.acknowledgeOpen(receiptId, saved: saved, verified: true) else { replyHandler(nil, "The notification destination changed."); return }
                }
                let result = await MailPush.shared.status(saved: saved)
                guard model.webView === view, model.active?.session == saved.session, model.active?.deployment == saved.deployment, !model.validating, !model.busy,
                      MailConnectionPolicy.action(body: ["version": body["version"] as Any, "action": "signOut"], document: view?.url, host: saved.deployment.host,
                        frameProtocol: message.frameInfo.securityOrigin.protocol, frameHost: message.frameInfo.securityOrigin.host, framePort: message.frameInfo.securityOrigin.port,
                        isMainFrame: message.frameInfo.isMainFrame, isActiveView: message.webView === model.webView) != nil else { replyHandler(nil, "The Mail connection changed."); return }
                replyHandler(result, nil)
            } catch { replyHandler(nil, error.localizedDescription) }
        }
    }
}
#endif
