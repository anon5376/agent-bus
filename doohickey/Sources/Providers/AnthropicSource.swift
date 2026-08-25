import Foundation
import Security

/// Real Claude quota, from the same endpoint Claude Code's own `/usage` uses.
///
/// This replaces the reconstructed 5-hour block that earlier versions inferred from
/// transcript history. That estimate was measured against the busiest block ever seen,
/// which is a plausible-looking number that can be badly wrong — on this machine it
/// read 79% left while the account was actually at 47%.
///
/// The credential is an OAuth access token, which Claude Code keeps in the login
/// keychain. Reading it prompts once for an unsigned build; approving with "Always
/// Allow" makes it silent afterwards. Falling back to `.credentials.json` covers setups
/// that store it on disk instead.
struct AnthropicSource {
    struct Result: Sendable {
        var state: ProviderState
        var reading: Reading
    }

    /// Windows the API returns that are worth surfacing, in the order they should read.
    private static let windowLabels: [(key: String, label: String)] = [
        ("five_hour", "5h session"),
        ("seven_day", "Weekly"),
        ("seven_day_opus", "Weekly Opus"),
        ("seven_day_sonnet", "Weekly Sonnet"),
    ]

    var token: String? {
        if let fromKeychain = Self.keychainToken() { return fromKeychain }
        let path = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".claude/.credentials.json")
        guard let data = try? Data(contentsOf: path),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let oauth = json["claudeAiOauth"] as? [String: Any],
              let value = oauth["accessToken"] as? String, !value.isEmpty
        else { return nil }
        return value
    }

    var isPresent: Bool { token != nil }

    func load() async -> Result {
        guard let token else {
            return Result(state: .notConfigured, reading: Reading())
        }
        guard let url = URL(string: "https://api.anthropic.com/api/oauth/usage") else {
            return Result(state: .failed("bad url"), reading: Reading())
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 12
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("oauth-2025-04-20", forHTTPHeaderField: "anthropic-beta")
        request.setValue("Doohickey/1.0", forHTTPHeaderField: "User-Agent")

        guard let (data, response) = try? await URLSession.shared.data(for: request) else {
            return Result(state: .offline("unreachable"), reading: Reading())
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            // An expired access token is the usual cause; Claude Code refreshes it on
            // next use, so this resolves itself rather than needing user action. Drop
            // the cached copy so the next refresh picks the new one up.
            if status == 401 { Self.invalidateToken() }
            return Result(state: .failed(status == 401 ? "token expired — run claude once" : "HTTP \(status)"),
                          reading: Reading())
        }

        var reading = Reading()
        reading.plan = Self.plan
        for (key, label) in Self.windowLabels {
            guard let window = json[key] as? [String: Any],
                  let utilization = num(window, "utilization")
            else { continue }
            reading.windows.append(LimitWindow(
                id: "anthropic-\(key)",
                label: label,
                usedFraction: utilization / 100,
                resetsAt: str(window, "resets_at").flatMap(ISO8601.parse),
                windowMinutes: key == "five_hour" ? 300 : 10_080
            ))
        }
        guard !reading.windows.isEmpty else { return Result(state: .noUsageAPI, reading: reading) }

        // Pay-as-you-go overage past the plan allowance, when the user has turned it on.
        if let extra = dict(json, "extra_usage"),
           (extra["is_enabled"] as? NSNumber)?.boolValue == true,
           let utilization = num(extra, "utilization") {
            reading.windows.append(LimitWindow(
                id: "anthropic-extra", label: "Extra usage",
                usedFraction: utilization / 100, resetsAt: nil, windowMinutes: nil
            ))
            reading.detail = "extra usage enabled"
        }
        return Result(state: .ok, reading: reading)
    }

    private static let services = ["Claude Code-credentials", "Claude Code"]

    /// Cached because the fallback path spawns a process, and the refresh timer fires
    /// every minute. Invalidated when the API rejects the token.
    private static let cache = TokenCache()

    private static func keychainToken() -> String? {
        if let cached = cache.get() { return cached }
        let token = directRead() ?? securityToolRead()
        if let token { cache.set(token) }
        return token
    }

    /// The direct path. Works when the keychain item's ACL admits this binary, which it
    /// will not for an ad-hoc signed build — hence the fallback below.
    private static func directRead() -> String? {
        for service in services {
            let query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecReturnData as String: true,
                kSecMatchLimit as String: kSecMatchLimitOne,
            ]
            var item: CFTypeRef?
            guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
                  let data = item as? Data,
                  let token = parse(data)
            else { continue }
            return token
        }
        return nil
    }

    /// `/usr/bin/security` is Apple-signed, so the keychain grants it access after the
    /// user approves once ("Always Allow"). This is the only way an unsigned menu bar
    /// app can reach a credential another app wrote, short of shipping a signed build
    /// with a matching team identifier.
    private static func securityToolRead() -> String? {
        for service in services {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/security")
            process.arguments = ["find-generic-password", "-s", service, "-w"]
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = FileHandle.nullDevice
            guard (try? process.run()) != nil else { continue }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            guard process.terminationStatus == 0, let token = parse(data) else { continue }
            return token
        }
        return nil
    }

    private static func parse(_ data: Data) -> String? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let oauth = json["claudeAiOauth"] as? [String: Any],
              let token = oauth["accessToken"] as? String, !token.isEmpty
        else { return nil }
        // The same blob names the plan, which the usage endpoint does not return.
        if let plan = oauth["subscriptionType"] as? String { planCache.set(plan) }
        return token
    }

    /// Plan name, cached alongside the token from the same keychain read.
    static var plan: String? { planCache.get() }
    private static let planCache = ValueCache()

    private final class ValueCache: @unchecked Sendable {
        private let lock = NSLock()
        private var value: String?
        func get() -> String? { lock.lock(); defer { lock.unlock() }; return value }
        func set(_ new: String) { lock.lock(); value = new; lock.unlock() }
    }

    static func invalidateToken() { cache.clear() }

    private final class TokenCache: @unchecked Sendable {
        private let lock = NSLock()
        private var token: String?
        private var storedAt = Date.distantPast

        func get() -> String? {
            lock.lock(); defer { lock.unlock() }
            // Claude Code rotates the access token periodically; re-reading every ten
            // minutes keeps a refreshed one from going unnoticed for long.
            guard Date().timeIntervalSince(storedAt) < 600 else { return nil }
            return token
        }

        func set(_ value: String) {
            lock.lock(); defer { lock.unlock() }
            token = value
            storedAt = Date()
        }

        func clear() {
            lock.lock(); defer { lock.unlock() }
            token = nil
            storedAt = .distantPast
        }
    }
}

/// Live Codex quota straight from the ChatGPT backend.
///
/// The transcripts carry a `rate_limits` block too, but it is only as fresh as the last
/// turn — after an idle evening it describes a window that has since reset. This is the
/// current state, and it also exposes the per-model allowances (Spark and friends) that
/// never appear in a rollout.
struct ChatGPTSource {
    struct Result: Sendable {
        var state: ProviderState
        var reading: Reading
    }

    private var auth: (token: String, account: String)? {
        let path = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".codex/auth.json")
        guard let data = try? Data(contentsOf: path),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let tokens = json["tokens"] as? [String: Any],
              let token = tokens["access_token"] as? String, !token.isEmpty
        else { return nil }
        return (token, (tokens["account_id"] as? String) ?? "")
    }

    var isPresent: Bool { auth != nil }

    func load() async -> Result {
        guard let auth else { return Result(state: .notConfigured, reading: Reading()) }
        guard let url = URL(string: "https://chatgpt.com/backend-api/wham/usage") else {
            return Result(state: .failed("bad url"), reading: Reading())
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 12
        request.setValue("Bearer \(auth.token)", forHTTPHeaderField: "Authorization")
        request.setValue(auth.account, forHTTPHeaderField: "chatgpt-account-id")
        request.setValue("Doohickey/1.0", forHTTPHeaderField: "User-Agent")

        guard let (data, response) = try? await URLSession.shared.data(for: request) else {
            return Result(state: .offline("unreachable"), reading: Reading())
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return Result(state: .failed(status == 401 ? "token expired — run codex once" : "HTTP \(status)"),
                          reading: Reading())
        }

        var reading = Reading()
        reading.plan = str(json, "plan_type")
        reading.windows = Self.windows(from: dict(json, "rate_limit"), name: nil)

        // Per-model allowances, each with their own pair of windows.
        for entry in (json["additional_rate_limits"] as? [[String: Any]] ?? []) {
            let name = str(entry, "limit_name")
            reading.windows += Self.windows(from: dict(entry, "rate_limit"), name: name)
        }

        if let credits = dict(json, "rate_limit_reset_credits"),
           let available = num(credits, "available_count"), available > 0 {
            reading.detail = "\(Int(available)) limit reset credit\(available == 1 ? "" : "s") available"
        }
        return Result(state: reading.windows.isEmpty ? .noUsageAPI : .ok, reading: reading)
    }

    private static func windows(from limit: [String: Any]?, name: String?) -> [LimitWindow] {
        guard let limit else { return [] }
        var result: [LimitWindow] = []
        for (key, fallback) in [("primary_window", "primary"), ("secondary_window", "secondary")] {
            guard let window = dict(limit, key), let percent = num(window, "used_percent") else { continue }
            let seconds = num(window, "limit_window_seconds") ?? 0
            let label = Self.label(seconds: Int(seconds), name: name) ?? fallback
            result.append(LimitWindow(
                id: "chatgpt-\(name ?? "main")-\(key)",
                label: label,
                usedFraction: percent / 100,
                resetsAt: num(window, "reset_at").map { Date(timeIntervalSince1970: $0) },
                windowMinutes: seconds > 0 ? Int(seconds / 60) : nil
            ))
        }
        return result
    }

    private static func label(seconds: Int, name: String?) -> String? {
        let span: String
        switch seconds {
        case 0: return name
        case ..<3600: span = "\(seconds / 60)m"
        case ..<86_400: span = "\(seconds / 3600)h"
        case 604_800: span = "weekly"
        default: span = "\(seconds / 86_400)d"
        }
        guard let name else { return span }
        return "\(name) \(span)"
    }
}

extension AnthropicSource.Result {
    /// A short reason to show under the row when the live reading could not be taken,
    /// so a fallback to the estimate is explained rather than silent.
    var statusHint: String? {
        switch state {
        case .ok: return nil
        case .notConfigured: return "no OAuth token — window inferred from your own history"
        case .noUsageAPI: return "account reports no windows"
        case .offline(let why), .failed(let why): return "\(why) — window inferred from history"
        }
    }
}

extension ChatGPTSource.Result {
    var statusHint: String? {
        switch state {
        case .ok: return nil
        case .notConfigured, .noUsageAPI: return nil
        case .offline(let why), .failed(let why): return "\(why) — showing last rollout"
        }
    }
}
