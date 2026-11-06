import SwiftUI
import AuthenticationServices
import WebKit
import CryptoKit
#if os(iOS)
import UIKit
#else
import AppKit
#endif

@MainActor final class ConnectionModel: NSObject, ObservableObject, ASWebAuthenticationPresentationContextProviding {
    @Published var domain = UserDefaults.standard.string(forKey: "deploymentDomain") ?? "" {
        didSet { if domain != oldValue, !busy, active == nil { error = nil; savedSessionRecovery = false } }
    }
    @Published private(set) var hasSavedSession = false
    @Published private(set) var savedSessionRecovery = false
    @Published var busy = false
    @Published var cleaning = false
    @Published var error: String?
    @Published var webView: WKWebView?
    @Published var active: SavedSession?
    @Published var settings = false
    @Published private(set) var sessionCheckState: SessionCheckState = .ready
    @Published private(set) var validationError: String?
    var validating: Bool { sessionCheckState != .ready }
    #if os(macOS)
    @Published var enabledMailCommands: Set<MailCommand> = []
    #endif
    private var browser: ASWebAuthenticationSession?
    #if os(macOS)
    private var browserCallback: AuthenticationResult?
    private var browserCallbackState: String?
    private var browserTimeout: Task<Void, Never>?
    @Published private(set) var canUseBrowserSignIn = false
    #endif
    private var task: Task<Void, Never>?
    private var ticket = UUID()
    private var deadline: Task<Void, Never>?
    private var currentStore: WKWebsiteDataStore?
    private let http = PrivateHTTP()
    private let validationOverride: (@MainActor (SavedSession) async throws -> Void)?
    init(validationOverride: (@MainActor (SavedSession) async throws -> Void)? = nil) {
        self.validationOverride = validationOverride
        super.init()
    }
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        #if os(iOS)
        return UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
        #else
        return NSApplication.shared.keyWindow ?? NSApplication.shared.windows.first ?? ASPresentationAnchor()
        #endif
    }
    func restore() {
        guard active == nil, !busy else { return }
        do {
            guard let saved = try SessionVault.read() else { return }
            hasSavedSession = true
            domain = saved.deployment.host; busy = true; let attempt = ticket
            task = Task {
                do {
                    let current = try await upgrade(saved)
                    try await validate(current)
                    guard attempt == ticket else { return }
                    if current.persistent && !saved.persistent { try SessionVault.write(current) }
                    try await install(current); busy = false
                } catch { if attempt == ticket { self.error = friendly(error); savedSessionRecovery = error is SessionAdmissionError; busy = false } }
            }
        } catch { self.error = friendly(error) }
    }
    func signIn(useBrowser: Bool = false) {
        guard !cleaning else { return }
        cancel(); error = nil; savedSessionRecovery = false; busy = true; let attempt = ticket
        task = Task {
            do {
                let deployment = try Deployment.parse(domain)
                let (data, response) = try await http.send(URLRequest(url: deployment.url("/apps/mail/native/configuration")))
                guard response.statusCode == 200 else { throw ConnectionError.message("Native sign-in is unavailable on this domain. Check the domain or ask its owner to enable EnoughMail native access.") }
                let configuration = try JSONDecoder().decode(NativeConfiguration.self, from: data)
                try configuration.validate(deployment)
                try Task.checkCancellation(); guard attempt == ticket else { return }
                let state = try randomProof(), verifier = try randomProof()
                let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncoded
                var login = URLComponents(url: deployment.url("/apps/mail/native/login"), resolvingAgainstBaseURL: false)!
                login.queryItems = [.init(name: "state", value: state), .init(name: "challenge", value: challenge)]
                if configuration.persistentSessionVersion == 1 { login.queryItems?.append(.init(name: "persistent", value: "1")) }
                let callback: URL
                #if os(macOS)
                if useBrowser { callback = try await authenticateInBrowser(login.url!, state: state) }
                else { callback = try await authenticate(login.url!) }
                #else
                callback = try await authenticate(login.url!)
                #endif
                try Task.checkCancellation(); guard attempt == ticket else { return }
                guard let code = authenticationCode(from: callback, state: state) else { throw ConnectionError.message("The sign-in response could not be verified. Try again.") }
                var request = URLRequest(url: deployment.url("/apps/mail/native/exchange")); request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try JSONSerialization.data(withJSONObject: ["code": code, "verifier": verifier])
                let (grantData, grantResponse) = try await http.send(request)
                guard grantResponse.statusCode == 200 else { throw ConnectionError.message("Sign-in expired before it finished. Try again.") }
                struct Grant: Decodable { let token: String; let session: MailSession; let authentication: String? }
                let grant = try JSONDecoder().decode(Grant.self, from: grantData)
                guard !grant.token.isEmpty, grant.token.count < 32768, !grant.token.contains(where: { $0.isWhitespace }), grant.session.valid else { throw ConnectionError.message("This deployment returned an invalid sign-in.") }
                if configuration.persistentSessionVersion == 1 && (grant.authentication != "native-session" || !SavedSession.validPersistentToken(grant.token)) { throw ConnectionError.message("Persistent sign-in could not be established. Try again.") }
                let saved = SavedSession(deployment: deployment, session: grant.session, token: grant.token, authentication: grant.authentication)
                try await validate(saved); try Task.checkCancellation(); guard attempt == ticket else { return }
                try SessionVault.write(saved)
                hasSavedSession = true
                UserDefaults.standard.set(deployment.host, forKey: "deploymentDomain"); domain = deployment.host
                try await install(saved); busy = false; settings = false
            } catch { if attempt == ticket {
                self.error = friendly(error); busy = false; browser = nil
                #if os(macOS)
                canUseBrowserSignIn = (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin
                #endif
            } }
        }
    }
    #if os(macOS)
    private func authenticateInBrowser(_ url: URL, state: String) async throws -> URL {
        return try await withCheckedThrowingContinuation { continuation in
            browserCallback = AuthenticationResult(continuation); browserCallbackState = state
            browserTimeout = Task {
                try? await Task.sleep(for: .seconds(300))
                if !Task.isCancelled { finishBrowserAuthentication(.failure(ConnectionError.message("Browser sign-in timed out. Try again."))) }
            }
            if !NSWorkspace.shared.open(url) {
                finishBrowserAuthentication(.failure(ConnectionError.message("Your browser could not open. Try again.")))
            }
        }
    }
    func receiveAuthenticationCallback(_ url: URL) {
        guard browserCallback != nil, let state = browserCallbackState,
              authenticationCode(from: url, state: state) != nil else { return }
        finishBrowserAuthentication(.success(url))
    }
    private func finishBrowserAuthentication(_ result: Result<URL, Error>) {
        let continuation = browserCallback
        browserCallback = nil; browserCallbackState = nil
        browserTimeout?.cancel(); browserTimeout = nil
        continuation?.finish(result)
    }
    #endif
    private func authenticate(_ url: URL) async throws -> URL {
        return try await withCheckedThrowingContinuation { continuation in
            let result = AuthenticationResult(continuation)
            let attempt = ticket
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "enoughmail-workspace") { url, error in
                Task { @MainActor in
                    guard attempt == self.ticket else { result.finish(.failure(CancellationError())); return }
                    self.browser = nil
                    if let error { result.finish(.failure(error)) }
                    else if let url { result.finish(.success(url)) }
                    else { result.finish(.failure(ConnectionError.message("Sign-in was canceled. You can try again."))) }
                }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = true
            browser = session
            if !session.start() {
                browser = nil
                result.finish(.failure(ConnectionError.message("The system sign-in window could not open. Try again.")))
            }
        }
    }
    func cancel() {
        ticket = UUID(); task?.cancel(); task = nil; browser?.cancel(); browser = nil; busy = false
        #if os(macOS)
        canUseBrowserSignIn = false
        finishBrowserAuthentication(.failure(CancellationError()))
        #endif
    }
    private func upgrade(_ saved: SavedSession) async throws -> SavedSession {
        if saved.persistent || validationOverride != nil { return saved }
        var request = URLRequest(url: saved.deployment.url("/apps/mail/native/upgrade")); request.httpMethod = "POST"
        request.setValue("CF_Authorization=" + saved.token, forHTTPHeaderField: "Cookie")
        request.setValue(saved.deployment.origin.absoluteString, forHTTPHeaderField: "Origin")
        let (data, response) = try await http.send(request)
        if response.statusCode == 404 { return saved }
        try SessionValidationPolicy.requireSuccessfulResponse(response.statusCode)
        struct Grant: Decodable { let token: String; let session: MailSession; let authentication: String }
        let grant = try JSONDecoder().decode(Grant.self, from: data)
        guard grant.authentication == "native-session", SavedSession.validPersistentToken(grant.token) else { throw ConnectionError.message("The deployment returned an invalid persistent sign-in.") }
        try SessionValidationPolicy.requireMatchingIdentity(grant.session, saved: saved.session)
        return SavedSession(deployment: saved.deployment, session: grant.session, token: grant.token, authentication: grant.authentication)
    }
    private func validate(_ saved: SavedSession) async throws {
        if let validationOverride { try await validationOverride(saved); return }
        if saved.persistent && !SavedSession.validPersistentToken(saved.token) { throw SessionAdmissionError("Your saved sign-in is invalid. Sign in again to continue.") }
        var request = URLRequest(url: saved.appURL("/apps/mail/api/session"))
        request.setValue(saved.cookieName + "=" + saved.token, forHTTPHeaderField: "Cookie")
        let (data, response) = try await http.send(request)
        try SessionValidationPolicy.requireSuccessfulResponse(response.statusCode)
        let current = try JSONDecoder().decode(MailSession.self, from: data)
        try SessionValidationPolicy.requireMatchingIdentity(current, saved: saved.session)
    }
    private func install(_ saved: SavedSession) async throws {
        deadline?.cancel()
        // Persistent recovery data is namespaced by verified deployment AND identity.
        // Never select a store until the live session has been checked.
        let store = try scopedStore(saved)
        currentStore = store
        let configuration = WKWebViewConfiguration(); configuration.websiteDataStore = store
        configuration.userContentController.add(MailConnectionHandler(self), name: "enoughMailConnection")
        let origin = String(data: try JSONSerialization.data(withJSONObject: saved.deployment.origin.absoluteString, options: .fragmentsAllowed), encoding: .utf8)!
        let host = String(data: try JSONSerialization.data(withJSONObject: saved.deployment.host, options: .fragmentsAllowed), encoding: .utf8)!
        #if os(macOS)
        let platform = "macOS"
        #else
        let platform = "iOS"
        #endif
        let connectionScript = """
        if (location.origin === \(origin) && /^\\/apps\\/mail(?:\\/|$)/.test(location.pathname)) {
          Object.defineProperty(window, 'enoughMailConnection', { value: Object.freeze({
            version: 1, deploymentHost: \(host), platform: '\(platform)', perform(action) {
              if (action !== 'signOut' && action !== 'changeDeployment') return false;
              window.webkit.messageHandlers.enoughMailConnection.postMessage({version: 1, action});
              return true;
            }
          }), configurable: false, writable: false });
        }
        """
        configuration.userContentController.addUserScript(WKUserScript(source: connectionScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        #if os(iOS)
        MailPush.shared.model = self
        configuration.userContentController.addScriptMessageHandler(MailPushHandler(self), contentWorld: .page, name: "enoughMailPush")
        let pushScript = """
        if (location.origin === \(origin) && /^\\/apps\\/mail(?:\\/|$)/.test(location.pathname)) {
          Object.defineProperty(window, 'enoughMailPush', { value: Object.freeze({ version: 1, deploymentHost: \(host),
            request(action, receiptId) {
              if (!['status','register','stop','acknowledgeOpen'].includes(action)) return Promise.reject(new Error('Unknown notification action'));
              if (action === 'acknowledgeOpen') {
                if (typeof receiptId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(receiptId)) return Promise.reject(new Error('Invalid notification receipt'));
                return window.webkit.messageHandlers.enoughMailPush.postMessage({version:1, action, receiptId});
              }
              if (receiptId !== undefined) return Promise.reject(new Error('Unexpected notification receipt'));
              return window.webkit.messageHandlers.enoughMailPush.postMessage({version:1, action});
            }
          }), configurable:false, writable:false });
        }
        """
        configuration.userContentController.addUserScript(WKUserScript(source: pushScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        #endif
        #if os(macOS)
        enabledMailCommands = []
        configuration.userContentController.add(MailCommandHandler(self), name: "enoughMailCommands")
        #endif
        if saved.persistent {
            let proxyScript = """
            (() => {
              const rewrite = input => {
                const url = new URL(input, location.href);
                if (url.origin !== location.origin) return url.href;
                if (url.pathname === '/api/apps') url.pathname = '/apps/mail/native/app/__platform/apps';
                else if (/^\\/apps\\/mail(?:\\/|$)/.test(url.pathname) && !url.pathname.startsWith('/apps/mail/native/')) url.pathname = '/apps/mail/native/app/' + url.pathname.replace(/^\\/apps\\/mail\\/?/, '');
                return url.href;
              };
              const originalFetch = window.fetch.bind(window);
              window.fetch = async (input, options) => {
                if (!(input instanceof Request)) return originalFetch(rewrite(input), options);
                const target = rewrite(input.url);
                if (target === input.url) return originalFetch(input, options);
                const init = { method: input.method, headers: input.headers, credentials: input.credentials, mode: input.mode, cache: input.cache, redirect: input.redirect, referrer: input.referrer, referrerPolicy: input.referrerPolicy, integrity: input.integrity, keepalive: input.keepalive, signal: input.signal };
                if (!['GET', 'HEAD'].includes(input.method) && !(options && 'body' in options)) init.body = await input.clone().arrayBuffer();
                return originalFetch(target, { ...init, ...options });
              };
              const open = XMLHttpRequest.prototype.open;
              XMLHttpRequest.prototype.open = function(method, url, ...args) { return open.call(this, method, rewrite(url), ...args); };
              if (window.EventSource) window.EventSource = new Proxy(window.EventSource, {
                construct(Target, args, newTarget) { return Reflect.construct(Target, [rewrite(args[0]), args[1]], newTarget); }
              });
            })();
            """
            configuration.userContentController.addUserScript(WKUserScript(source: proxyScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        guard let cookie = saved.cookie else { throw ConnectionError.message("Your saved sign-in is invalid. Sign in again to continue.") }
        await configuration.websiteDataStore.httpCookieStore.setCookie(cookie)
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.allowsBackForwardNavigationGestures = true
        #if os(iOS)
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.scrollView.bounces = false
        #endif
        active = saved; webView = view; error = nil; sessionCheckState = .ready; validationError = nil
        view.load(URLRequest(url: saved.appURL("/apps/mail/")))
        let parts = saved.token.split(separator: ".")
        if !saved.persistent && parts.count == 3 {
            var payload = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
            payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
            if let data = Data(base64Encoded: payload), let claims = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let exp = claims["exp"] as? Double {
                let delay = max(0, exp - Date().timeIntervalSince1970)
                deadline = Task { try? await Task.sleep(for: .seconds(delay)); if !Task.isCancelled { expire() } }
            }
        }
    }
    private func scopedStore(_ saved: SavedSession) throws -> WKWebsiteDataStore {
        let scope = try JSONEncoder().encode([saved.deployment.origin.absoluteString, saved.session.actorId, saved.session.organizationId, saved.session.workspaceId])
        let hex = Data(SHA256.hash(data: scope)).map { String(format: "%02x", $0) }.joined()
        let raw = Array(hex.prefix(32))
        let groups = [0..<8, 8..<12, 12..<16, 16..<20, 20..<32].map { String(raw[$0]) }
        return WKWebsiteDataStore(forIdentifier: UUID(uuidString: groups.joined(separator: "-"))!)
    }
    func foreground() {
        guard let saved = active, let originalView = webView, !busy, sessionCheckState != .checking else { return }
        sessionCheckState = .checking; validationError = nil; let attempt = ticket
        blockInteraction(originalView)
        task = Task {
            do {
                try await validate(saved)
                guard attempt == ticket, webView === originalView else { return }
                originalView.isHidden = false
                #if os(iOS)
                originalView.isUserInteractionEnabled = true
                #endif
                sessionCheckState = .ready; validationError = nil
                #if os(iOS)
                MailPush.shared.wakePendingMessage()
                #endif
            } catch {
                guard attempt == ticket, webView === originalView else { return }
                if error is SessionAdmissionError { expire(); self.error = friendly(error) }
                else { sessionCheckState = .suspended; validationError = friendly(error) }
            }
        }
    }
    private func blockInteraction(_ view: WKWebView) {
        view.isHidden = true
        #if os(iOS)
        view.endEditing(true); view.isUserInteractionEnabled = false
        #else
        view.window?.makeFirstResponder(nil)
        #endif
    }
    func expire() { cancel(); deadline?.cancel(); if let view = webView { blockInteraction(view); view.stopLoading() }; webView = nil; active = nil; sessionCheckState = .ready; validationError = nil; savedSessionRecovery = hasSavedSession; error = "Your session expired. Sign in again to continue. Saved cloud drafts are still on your deployment." }
    func signOut() {
        if let saved = active, saved.persistent {
            Task {
                var request = URLRequest(url: saved.deployment.url("/apps/mail/native/revoke")); request.httpMethod = "POST"
                request.setValue(saved.cookieName + "=" + saved.token, forHTTPHeaderField: "Cookie")
                request.setValue(saved.deployment.origin.absoluteString, forHTTPHeaderField: "Origin")
                _ = try? await http.send(request)
            }
        }
        #if os(iOS)
        MailPush.shared.stop()
        #endif
        cancel(); deadline?.cancel(); if let view = webView { blockInteraction(view); view.stopLoading() }; webView = nil; active = nil; sessionCheckState = .ready; validationError = nil
        guard !cleaning else { return }
        let oldStore = currentStore ?? (try? SessionVault.read()).flatMap { try? scopedStore($0) }; currentStore = nil
        do {
            try SessionVault.write(nil); hasSavedSession = false; savedSessionRecovery = false; error = nil; settings = false
            #if os(iOS)
            let temporary = FileManager.default.temporaryDirectory
            for item in (try? FileManager.default.contentsOfDirectory(at: temporary, includingPropertiesForKeys: nil)) ?? [] {
                if item.lastPathComponent.hasPrefix("mail-"), UUID(uuidString: String(item.lastPathComponent.dropFirst(5))) != nil { try? FileManager.default.removeItem(at: item) }
            }
            #endif
            if let oldStore {
                cleaning = true
                Task { await oldStore.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast); cleaning = false }
            }
        } catch { self.error = friendly(error) }
    }
    func switchDeployment() { signOut(); domain = ""; UserDefaults.standard.removeObject(forKey: "deploymentDomain") }
    func friendly(_ error: Error) -> String {
        if let e = error as? ASWebAuthenticationSessionError, e.code == .canceledLogin { return "Sign-in was canceled. You can try again." }
        if error is CancellationError { return "Sign-in was canceled. You can try again." }
        if let e = error as? URLError {
            if e.code == .notConnectedToInternet || e.code == .networkConnectionLost { return "You’re offline. Reconnect and try again. Your saved cloud drafts stay on your deployment." }
            if e.code == .cannotFindHost || e.code == .cannotConnectToHost { return "This deployment could not be reached. Check the domain and try again." }
            return "A secure connection could not be completed. Check your connection and try again."
        }
        if error is DecodingError { return "This domain did not return a compatible EnoughMail response. Check the domain or contact its owner." }
        if error is ConnectionError || error is SessionAdmissionError { return error.localizedDescription }
        return "The secure connection could not finish. Try again. If this continues, close and reopen EnoughMail."
    }
}
