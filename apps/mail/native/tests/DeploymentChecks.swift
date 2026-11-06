import Foundation
@main struct DeploymentChecks {
    static func main() throws {
        for input in ["mail.example.com", "https://mail.example.com", "https://MAIL.EXAMPLE.COM/", " https://mail.example.com:443 "] {
            let origin = try Deployment.parse(input).origin.absoluteString
            precondition(origin == "https://mail.example.com")
        }
        for input in ["", "http://mail.example.com", "https://user:pass@mail.example.com", "https://mail.example.com/apps/mail/", "mail.example.com?token=secret", "mail.example.com#identity", "https://mail.example.com:8443", "127.0.0.1", "localhost", "mail..example.com", ".example.com", "mail.example.com.", "https://mail.example.com\\@other.example.com"] {
            do { _ = try Deployment.parse(input); fatalError("Accepted invalid deployment: \(input)") } catch {}
        }
        let deployment = try Deployment.parse("other.example.com")
        let config = Data(#"{"product":"enough-mail","version":1,"origin":"https://other.example.com","login":"/apps/mail/native/login","exchange":"/apps/mail/native/exchange","session":"/apps/mail/api/session","app":"/apps/mail/","authentication":"cloudflare-access","callback":"enoughmail-workspace://authentication/callback"}"#.utf8)
        let parsed = try JSONDecoder().decode(NativeConfiguration.self, from: config)
        try parsed.validate(deployment)
        do { try parsed.validate(Deployment.parse("mail.example.com")); fatalError("Accepted configuration from another origin") } catch {}
        let proofs = try (0..<32).map { _ in try randomProof() }
        precondition(Set(proofs).count == 32 && proofs.allSatisfy { $0.count == 43 && $0.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") } })
        let code = String(repeating: "a", count: 64)
        let base = "enoughmail-workspace://authentication/callback"
        precondition(authenticationCode(from: URL(string: base + "?state=current&code=" + code)!, state: "current") == code)
        for bad in [
            base + "?state=previous&code=" + code,
            base + "?state=current&state=current&code=" + code,
            base + "?state=current&code=" + code + "&code=" + code,
            base + "?state=current&code=" + code + "&extra=1",
            base + "?state=current&code=" + String(code.dropLast()),
            base + "?state=current&code=" + String(repeating: "g", count: 64),
            base + "?state=current&code=" + code + "#fragment",
            "https://authentication/callback?state=current&code=" + code,
            "enoughmail-workspace://other/callback?state=current&code=" + code,
            "enoughmail-workspace://authentication/other?state=current&code=" + code,
            "enoughmail-workspace://user@authentication/callback?state=current&code=" + code,
            "enoughmail-workspace://authentication:443/callback?state=current&code=" + code
        ] { precondition(authenticationCode(from: URL(string: bad)!, state: "current") == nil) }
        let identity = MailSession(actorId: "actor", organizationId: "org", workspaceId: "workspace")
        let persistent = SavedSession(deployment: deployment, session: identity, token: "ems_" + String(repeating: "a", count: 64), authentication: "native-session")
        precondition(persistent.persistent && persistent.cookieName == "EnoughMailNativeSession")
        // Foundation URL.path removes the root's trailing slash. The native
        // navigation delegate must still admit the very first app document.
        precondition(SavedSession.isNativeAppPath(persistent.appURL("/apps/mail/").path))
        precondition(SavedSession.isNativeAppPath("/apps/mail/native/app/"))
        precondition(SavedSession.isNativeAppPath("/apps/mail/native/app/jmap/session"))
        for path in ["/apps/mail/native/application", "/apps/mail/native/app-elsewhere", "/apps/mail/native/login", "/apps/mail/"] { precondition(!SavedSession.isNativeAppPath(path)) }
        precondition(persistent.cookie?.isSecure == true && persistent.cookie?.isHTTPOnly == true && persistent.cookie?.path == "/apps/mail/native")
        precondition(persistent.appURL("/apps/mail?account=one#message").absoluteString == "https://other.example.com/apps/mail/native/app/?account=one#message")
        precondition(persistent.appURL("/apps/mail/api/blob/a%2Fb?download=1").absoluteString == "https://other.example.com/apps/mail/native/app/api/blob/a%2Fb?download=1")
        let recovered = try JSONDecoder().decode(SavedSession.self, from: JSONEncoder().encode(persistent))
        precondition(recovered.persistent && recovered.session == identity)
        let legacy = SavedSession(deployment: deployment, session: identity, token: "provider-token")
        precondition(!legacy.persistent && legacy.cookieName == "CF_Authorization")
        precondition(legacy.appURL("/apps/mail/") == deployment.url("/apps/mail/"))
        precondition(SavedSession.validPersistentToken(persistent.token))
        for token in ["ems_" + String(repeating: "g", count: 64), "ems_" + String(repeating: "a", count: 63) + ";", "provider-token"] { precondition(!SavedSession.validPersistentToken(token)) }
        print("Native deployment checks passed: domain rejection, independent origin, fixed paths, random PKCE proof.")
    }
}
