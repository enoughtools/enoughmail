import Foundation

@main struct AuthenticationLifecycleChecks {
    @MainActor static func check(_ first: Result<URL, Error>, succeeds: Bool) async {
        var completion: AuthenticationResult?
        let task = Task { @MainActor in
            try await withCheckedThrowingContinuation { continuation in
                completion = AuthenticationResult(continuation)
            }
        }
        while completion == nil { await Task.yield() }
        let callback = URL(string: "enoughmail-workspace://authentication/callback")!
        completion!.finish(first)
        precondition(!completion!.pending)
        // A late system callback/repeated URL must never resume the continuation twice.
        completion!.finish(.success(callback))
        completion!.finish(.failure(CancellationError()))
        do { _ = try await task.value; precondition(succeeds) }
        catch { precondition(!succeeds) }
    }
    @MainActor static func main() async {
        await check(.success(URL(string: "enoughmail-workspace://authentication/callback")!), succeeds: true)
        await check(.failure(CancellationError()), succeeds: false)
        await check(.failure(ConnectionError.message("Browser sign-in timed out.")), succeeds: false)
        await check(.failure(ConnectionError.message("The system sign-in window could not open.")), succeeds: false)
        print("Authentication lifecycle passed: success/replay, cancellation/late reply, timeout/late reply, start failure/system completion.")
    }
}
