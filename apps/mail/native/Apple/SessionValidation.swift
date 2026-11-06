import Foundation

enum SessionCheckState { case ready, checking, suspended }

struct SessionAdmissionError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

enum SessionValidationPolicy {
    static func requireMatchingIdentity(_ current: MailSession, saved: MailSession) throws {
        guard current.valid else { throw ConnectionError.message("Your deployment returned an incomplete session check. Retry the session check.") }
        guard current == saved else { throw SessionAdmissionError("The signed-in account changed. Sign out, then sign in with the correct account.") }
    }
    static func requireSuccessfulResponse(_ status: Int) throws {
        if status == 200 { return }
        if status == 401 || status == 403 {
            throw SessionAdmissionError("Your session expired or access changed. Sign in again to continue.")
        }
        throw ConnectionError.message("Your deployment could not verify access right now. Reconnect and retry the session check.")
    }
}
