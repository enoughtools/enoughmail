import Foundation
import CryptoKit
import Security

struct Deployment: Equatable, Codable {
    let origin: URL
    static func parse(_ input: String) throws -> Deployment {
        let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let raw = value.contains("://") ? value : "https://" + value
        guard let c = URLComponents(string: raw), c.scheme == "https", c.user == nil, c.password == nil,
              c.query == nil, c.fragment == nil, c.port == nil || c.port == 443,
              c.path.isEmpty || c.path == "/", let host = c.host?.lowercased(), host.count <= 253,
              host.contains("."), !host.hasSuffix("."), host.split(separator: ".", omittingEmptySubsequences: false).allSatisfy({ label in
                  !label.isEmpty && label.count <= 63 && label.first != "-" && label.last != "-" && label.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }
              }), !host.allSatisfy({ $0.isNumber || $0 == "." }), let origin = URL(string: "https://" + host) else {
            throw ConnectionError.message("Enter a deployment domain, such as mail.example.com. Use HTTPS without a path, port, or sign-in details.")
        }
        return Deployment(origin: origin)
    }
    var host: String { origin.host! }
    func url(_ path: String) -> URL { URL(string: path, relativeTo: origin)!.absoluteURL }
}
struct MailSession: Codable, Equatable {
    let actorId: String; let organizationId: String; let workspaceId: String
    var valid: Bool { !actorId.isEmpty && !organizationId.isEmpty && !workspaceId.isEmpty }
}
struct SavedSession: Codable {
    let deployment: Deployment; let session: MailSession; let token: String
    let authentication: String?
    init(deployment: Deployment, session: MailSession, token: String, authentication: String? = nil) {
        self.deployment = deployment; self.session = session; self.token = token; self.authentication = authentication
    }
    static func validPersistentToken(_ token: String) -> Bool {
        token.hasPrefix("ems_") && token.count == 68 && token.dropFirst(4).allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
    }
    static func isNativeAppPath(_ path: String) -> Bool {
        path == "/apps/mail/native/app" || path.hasPrefix("/apps/mail/native/app/")
    }
    var persistent: Bool { authentication == "native-session" }
    var cookieName: String { persistent ? "EnoughMailNativeSession" : "CF_Authorization" }
    var cookie: HTTPCookie? {
        let path = persistent ? "/apps/mail/native" : "/"
        return HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": cookieName + "=" + token + "; Path=" + path + "; Secure; HttpOnly; SameSite=Strict"], for: deployment.origin).first
    }
    func appURL(_ path: String) -> URL {
        guard persistent else { return deployment.url(path) }
        var components = URLComponents(url: deployment.url(path), resolvingAgainstBaseURL: false)!
        let source = components.percentEncodedPath
        guard source == "/apps/mail" || source.hasPrefix("/apps/mail/") else { return deployment.url(path) }
        let suffix = source == "/apps/mail" ? "" : String(source.dropFirst("/apps/mail/".count))
        components.percentEncodedPath = "/apps/mail/native/app/" + suffix
        return components.url!
    }
}
struct NativeConfiguration: Decodable {
    let product: String; let version: Int; let origin: String; let login: String; let exchange: String
    let session: String; let app: String; let authentication: String; let callback: String
    let persistentSessionVersion: Int?
    func validate(_ deployment: Deployment) throws {
        guard persistentSessionVersion == nil || persistentSessionVersion == 1,
              product == "enough-mail", version == 1, origin == deployment.origin.absoluteString,
              login == "/apps/mail/native/login", exchange == "/apps/mail/native/exchange", session == "/apps/mail/api/session",
              app == "/apps/mail/", authentication == "cloudflare-access", callback == "enoughmail-workspace://authentication/callback" else {
            throw ConnectionError.message("This domain does not advertise a compatible EnoughMail app. Ask its owner to enable native app sign-in.")
        }
    }
}
enum ConnectionError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let value) = self { return value }; return nil }
}
final class PrivateHTTP: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil; configuration.urlCache = nil; configuration.timeoutIntervalForRequest = 20
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse, data.count < 256 * 1024 else { throw ConnectionError.message("The deployment returned an unexpected response.") }
        return (data, response)
    }
}
enum SessionVault {
    private static var query: [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: Bundle.main.bundleIdentifier! + ".deployment", kSecAttrAccount as String: "active"] }
    static func read() throws -> SavedSession? {
        var q = query; q[kSecReturnData as String] = true
        var result: CFTypeRef?; let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw ConnectionError.message("Your saved sign-in could not be opened. Sign in again.") }
        return try JSONDecoder().decode(SavedSession.self, from: data)
    }
    static func write(_ value: SavedSession?) throws {
        if let value {
            let attributes: [String: Any] = [kSecValueData as String: try JSONEncoder().encode(value), kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
            let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
            if status == errSecSuccess { return }
            guard status == errSecItemNotFound else { throw ConnectionError.message("Your sign-in could not be saved securely. Your previous sign-in is retained.") }
            let q = query.merging(attributes) { _, value in value }
            guard SecItemAdd(q as CFDictionary, nil) == errSecSuccess else { throw ConnectionError.message("Your sign-in could not be saved securely. Try again.") }
        } else {
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw ConnectionError.message("Your saved sign-in could not be removed. Try again.") }
        }
    }
}
@MainActor final class AuthenticationResult {
    private var continuation: CheckedContinuation<URL, Error>?
    private(set) var pending = true
    init(_ continuation: CheckedContinuation<URL, Error>) { self.continuation = continuation }
    func finish(_ result: Result<URL, Error>) {
        guard pending else { return }
        pending = false
        let continuation = continuation; self.continuation = nil
        continuation?.resume(with: result)
    }
}
func authenticationCode(from url: URL, state: String) -> String? {
    guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false),
          c.scheme == "enoughmail-workspace", c.host == "authentication", c.path == "/callback",
          c.user == nil, c.password == nil, c.port == nil, c.fragment == nil,
          let items = c.queryItems, items.count == 2,
          items.filter({ $0.name == "state" }).count == 1,
          items.first(where: { $0.name == "state" })?.value == state,
          items.filter({ $0.name == "code" }).count == 1,
          let code = items.first(where: { $0.name == "code" })?.value,
          code.count == 64, code.allSatisfy({ $0.isHexDigit }) else { return nil }
    return code
}
func randomProof() throws -> String {
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw ConnectionError.message("Sign-in could not start securely. Try again.") }
    return Data(bytes).base64URLEncoded
}
extension Data { var base64URLEncoded: String { base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") } }
