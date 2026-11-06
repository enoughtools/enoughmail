import SwiftUI
@main struct EnoughMailApp: App {
    #if os(iOS)
    @UIApplicationDelegateAdaptor(MailPush.self) private var pushDelegate
    #endif
    @StateObject private var model = ConnectionModel()
    var body: some Scene {
        WindowGroup { MailRoot(model: model)
            #if os(iOS)
            .ignoresSafeArea(.container)
            .background(Color(uiColor: .systemBackground))
            #endif
            #if os(macOS)
            .frame(minWidth: 720, minHeight: 480)
            .ignoresSafeArea(.container, edges: .top)
            .onOpenURL { model.receiveAuthenticationCallback($0) }
            .handlesExternalEvents(preferring: ["*"], allowing: ["*"])
            #endif
        }
        #if os(macOS)
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1200, height: 800)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New Message") { model.perform(.newMessage) }.keyboardShortcut("n").disabled(!model.canPerform(.newMessage))
            }
            CommandGroup(after: .saveItem) {
                Button("Save and Close Draft") { model.perform(.saveAndClose) }.keyboardShortcut("s").disabled(!model.canPerform(.saveAndClose))
            }
            CommandMenu("Mailbox") {
                Button("Inbox") { model.perform(.inbox) }.disabled(!model.canPerform(.inbox))
                Button("Drafts") { model.perform(.drafts) }.disabled(!model.canPerform(.drafts))
                Divider()
                Button("Refresh") { model.perform(.refresh) }.keyboardShortcut("r").disabled(!model.canPerform(.refresh))
                Button("Back to Messages") { model.perform(.backToMessages) }.keyboardShortcut("[").disabled(!model.canPerform(.backToMessages))
            }
        }
        #endif
    }
}
struct MailRoot: View {
    @ObservedObject var model: ConnectionModel
    @Environment(\.scenePhase) private var scenePhase
    #if os(iOS)
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    private var compactSetup: Bool { verticalSizeClass == .compact }
    #else
    private var compactSetup: Bool { false }
    #endif
    @State private var confirmSignOut = false
    @State private var confirmSwitch = false
    var body: some View {
        VStack(spacing: 0) {
            if let web = model.webView, model.active != nil {
                if let error = model.error, !model.validating {
                    HStack { Text(error).font(.callout); Spacer(); Button("Retry") { model.error = nil; web.reload() } }.padding(12).background(.yellow.opacity(0.12))
                }
                ZStack {
                    MailWebView(view: web, model: model)
                        .opacity(model.validating || scenePhase != .active ? 0 : 1)
                        .allowsHitTesting(!model.validating && scenePhase == .active)
                        .accessibilityHidden(model.validating || scenePhase != .active)
                    if model.sessionCheckState == .checking { ProgressView("Checking your session…") }
                    else if model.sessionCheckState == .suspended {
                        VStack(spacing: 12) {
                            Text("Mail is paused").font(.headline)
                            Text(model.validationError ?? "Your deployment could not verify access right now.")
                            Text("This window’s mail view stays in place until your deployment verifies access.").font(.callout).foregroundStyle(.secondary)
                            Button("Retry session check") { model.foreground() }.buttonStyle(.borderedProminent)
                            Button("Deployment settings") { model.settings = true }
                        }.multilineTextAlignment(.center).padding(24).frame(maxWidth: 460)
                    }
                }
            } else { setup }
        }
        .sheet(isPresented: $model.settings) { settings }
        .task { model.restore() }
        .onChange(of: scenePhase) { _, phase in if phase == .active { model.foreground() } }
    }
    private var setup: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: compactSetup ? 10 : 20) {
                if !compactSetup { Image("EnoughMark").resizable().scaledToFit().frame(width: 64, height: 64).accessibilityHidden(true) }
                Text("Your mail. Your cloud.").font(compactSetup ? .title2.bold() : .largeTitle.bold())
                Text("Connect to your EnoughMail deployment. You’ll sign in securely through its Cloudflare Access provider.").foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 8) {
                    Text("Deployment domain").font(.headline)
                    TextField("mail.example.com", text: $model.domain).textFieldStyle(.roundedBorder).onSubmit { model.signIn() }
                        #if os(iOS)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        #endif
                        .disabled(model.busy || model.cleaning).accessibilityIdentifier("deployment-domain")
                    Text("Enter a domain or HTTPS origin. No path is needed.").font(.caption).foregroundStyle(.secondary)
                }
                if let error = model.error { Text(error).foregroundStyle(.red).accessibilityIdentifier("connection-error") }
                if model.cleaning {
                    ProgressView("Removing this device’s session…")
                } else if model.busy {
                    ProgressView("Connecting securely…")
                    Button("Cancel sign-in") { model.cancel(); model.error = "Sign-in was canceled. You can try again." }
                } else {
                    Button("Connect and sign in") { model.signIn() }.buttonStyle(.borderedProminent).disabled(model.domain.trimmingCharacters(in: .whitespaces).isEmpty).accessibilityIdentifier("connect")
                    #if os(macOS)
                    if model.canUseBrowserSignIn {
                        Button("Open sign-in in browser") { model.signIn(useBrowser: true) }
                        Text("If the system sign-in window closes before you can sign in, continue in your browser.").font(.footnote).foregroundStyle(.secondary)
                    }
                    #endif
                }
                if model.savedSessionRecovery && model.error != nil && !model.busy && !model.cleaning {
                    Button("Forget saved sign-in") { confirmSignOut = true }
                }
                Text("Your deployment controls your account and mailbox. You can change deployments in settings.").font(.footnote).foregroundStyle(.secondary)
            }.padding(compactSetup ? 14 : 24).frame(maxWidth: compactSetup ? 680 : 480).frame(maxWidth: .infinity)
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
        .confirmationDialog("Forget saved sign-in?", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("Forget saved sign-in", role: .destructive) { model.signOut() }
        } message: { Text("This device’s session and local recovery data will be removed. Saved cloud drafts remain on the deployment.") }
    }
    private var settings: some View {
        settingsContent
        .confirmationDialog("Sign out on this device?", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { model.signOut() }
        } message: { Text("Saved cloud drafts remain on the deployment. This device’s mail session and local recovery data will be removed.") }
        .confirmationDialog("Change deployment?", isPresented: $confirmSwitch, titleVisibility: .visible) {
            Button("Change deployment", role: .destructive) { model.switchDeployment() }
        } message: { Text("Save any draft first. This device will sign out and remove its local web session before you enter another domain.") }
    }
    @ViewBuilder private var settingsContent: some View {
        #if os(macOS)
        VStack(alignment: .leading, spacing: 20) {
            Text("Deployment settings").font(.title2.bold())
            GroupBox {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Connected deployment").font(.headline)
                    Text(model.active?.deployment.host ?? model.domain).textSelection(.enabled)
                    Text("Before signing out or switching, finish saving any draft and wait for its saved confirmation.").foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 12) {
                        Button("Sign out on this device") { confirmSignOut = true }
                        Button("Change deployment") { confirmSwitch = true }
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(12)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("EnoughMail 1.0 · Beta").font(.headline)
                Text("Your deployment owns your mail and saved drafts. Cloudflare Access verifies your account in the system browser.").foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }.font(.callout)
            HStack { Spacer(); Button("Done") { model.settings = false }.keyboardShortcut(.defaultAction) }
        }.padding(24).frame(width: 500)
        #else
        NavigationStack {
            Form {
                Section("Connected deployment") {
                    Text(model.active?.deployment.host ?? model.domain)
                    Text("Mail and saved drafts live on this deployment. Before signing out or switching, finish saving any draft and wait for its saved confirmation.").font(.callout).foregroundStyle(.secondary)
                }
                Section {
                    Button("Sign out on this device") { confirmSignOut = true }
                    Button("Change deployment") { confirmSwitch = true }
                }
                Section("About") { Text("EnoughMail 1.0 · Beta"); Text("Cloudflare Access uses the system authentication browser. Mail opens only after your deployment verifies your account.").font(.callout) }
            }.navigationTitle("Deployment settings")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { model.settings = false } } }
        }
        #endif
    }
}
