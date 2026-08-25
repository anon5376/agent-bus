import Foundation

/// Cursor has no API key — it authenticates with the `WorkosCursorSessionToken` cookie
/// its app stores. Two calls are needed: the plan comes from one endpoint and the usage
/// counters from another, and the user id the second one wants is the first half of the
/// cookie value itself.
struct CursorSource {
    let spec = Catalogue.cursor

    struct Result: Sendable {
        var state: ProviderState
        var reading: Reading
    }

    var isPresent: Bool { spec.credential() != nil }

    func load() async -> Result {
        guard let token = spec.credential() else {
            return Result(state: .notConfigured, reading: Reading())
        }
        // `user_01ABC%3A%3A<jwt>` — the id is everything before the encoded "::".
        let userID = token.components(separatedBy: "%3A%3A").first ?? ""

        async let planTask = get("https://cursor.com/api/auth/stripe", token: token)
        async let usageTask = get("https://cursor.com/api/usage?user=\(userID)", token: token)
        let plan = await planTask
        let usage = await usageTask

        guard plan != nil || usage != nil else {
            return Result(state: .offline("unreachable"), reading: Reading())
        }

        var reading = Reading()
        if let plan {
            let membership = str(plan, "individualMembershipType") ?? str(plan, "membershipType")
            reading.plan = membership?.replacingOccurrences(of: "_", with: " ")
            if let trialDays = num(plan, "daysRemainingOnTrial"), trialDays > 0 {
                reading.detail = "\(Int(trialDays))d left on trial"
            }
        }

        if let usage {
            // Each model family carries its own allowance. Only the ones with a stated
            // maximum can become a window; unlimited families would otherwise render as
            // a full bar that never moves.
            var windows: [LimitWindow] = []
            for (family, raw) in usage {
                guard family != "startOfMonth", let entry = raw as? [String: Any] else { continue }
                guard let max = num(entry, "maxRequestUsage"), max > 0 else { continue }
                let used = num(entry, "numRequests") ?? 0
                windows.append(LimitWindow(
                    id: "cursor-\(family)",
                    label: family == "gpt-4" ? "Premium requests" : family,
                    usedFraction: used / max,
                    resetsAt: monthReset(usage),
                    windowMinutes: nil
                ))
            }
            reading.windows = windows.sorted { $0.usedFraction > $1.usedFraction }

            if windows.isEmpty {
                let requests = Int(num(dict(usage, "gpt-4"), "numRequestsTotal") ?? 0)
                // Usage-based plans report no ceiling at all, only a running count.
                reading.detail = [reading.detail, "\(requests) requests this cycle"]
                    .compactMap { $0 }.joined(separator: " · ")
            }
        }
        return Result(state: .ok, reading: reading)
    }

    /// Cursor's allowances roll over monthly from the date in `startOfMonth`.
    private func monthReset(_ usage: [String: Any]) -> Date? {
        guard let stamp = str(usage, "startOfMonth"), let start = ISO8601.parse(stamp) else { return nil }
        return Calendar.current.date(byAdding: .month, value: 1, to: start)
    }

    private func get(_ url: String, token: String) async -> [String: Any]? {
        guard let url = URL(string: url) else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 12
        request.setValue("WorkosCursorSessionToken=\(token)", forHTTPHeaderField: "Cookie")
        request.setValue("Doohickey/1.0", forHTTPHeaderField: "User-Agent")
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode)
        else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }
}

/// Local models cost nothing and have no quota, so the row exists only to confirm the
/// runtime is up and say what is loaded. Absent entirely when Ollama is not running.
struct OllamaSource {
    private var base: String {
        ProcessInfo.processInfo.environment["OLLAMA_HOST"].map {
            $0.hasPrefix("http") ? $0 : "http://\($0)"
        } ?? "http://127.0.0.1:11434"
    }

    func load() async -> Reading? {
        guard let url = URL(string: base + "/api/tags") else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse, http.statusCode == 200,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let models = json["models"] as? [[String: Any]]
        else { return nil }

        var reading = Reading()
        reading.plan = "local"
        let bytes = models.compactMap { num($0, "size") }.reduce(0, +)
        reading.detail = "\(models.count) model\(models.count == 1 ? "" : "s") · \(Format.bytes(bytes)) on disk"
        return reading
    }
}
