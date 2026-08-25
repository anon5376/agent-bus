import Foundation

/// Cursor authenticates with the `WorkosCursorSessionToken` cookie its app stores, not
/// an API key. Three of its dashboard endpoints together give a complete picture, and
/// all of them reject a bare cookie — they need `Origin` and `Referer` as well, which is
/// why an earlier version saw 403s and wrongly concluded the data was unavailable.
struct CursorSource {
    let spec = Catalogue.cursor

    struct Result: Sendable {
        var state: ProviderState
        var reading: Reading
        var tokens: TokenCounts
        var models: [ModelTotal]
        var costUSD: Double
        var events: Int
        var lastActivity: Date?
    }

    var isPresent: Bool { spec.credential() != nil }

    func load() async -> Result {
        let empty = Result(state: .notConfigured, reading: Reading(), tokens: TokenCounts(),
                           models: [], costUSD: 0, events: 0, lastActivity: nil)
        guard let token = spec.credential() else { return empty }

        async let summaryTask = call("usage-summary", method: "GET", token: token)
        async let sandTask = call("dashboard/get-sand-usage-status", method: "POST", token: token)
        async let eventsTask = call("dashboard/get-filtered-usage-events", method: "POST", token: token)

        let summary = await summaryTask
        let sand = await sandTask
        let events = await eventsTask

        guard summary != nil || sand != nil else {
            return Result(state: .offline("unreachable"), reading: Reading(), tokens: TokenCounts(),
                          models: [], costUSD: 0, events: 0, lastActivity: nil)
        }

        var reading = Reading()
        var result = Result(state: .ok, reading: reading, tokens: TokenCounts(),
                            models: [], costUSD: 0, events: 0, lastActivity: nil)

        if let summary {
            reading.plan = str(summary, "membershipType")?.replacingOccurrences(of: "_", with: " ")
            let cycleEnd = str(summary, "billingCycleEnd").flatMap(ISO8601.parse)
            let plan = dict(dict(summary, "individualUsage"), "plan")

            // `remaining` and `limit` are stated outright, so no arithmetic to get wrong.
            if let limit = num(plan, "limit"), limit > 0, let remaining = num(plan, "remaining") {
                reading.windows.append(LimitWindow(
                    id: "cursor-plan", label: "Plan requests",
                    usedFraction: 1 - remaining / limit, resetsAt: cycleEnd, windowMinutes: nil
                ))
                reading.detail = "\(Int(remaining)) of \(Int(limit)) requests left"
            }
            // A separate figure that Cursor's own dashboard headlines, measured against
            // included spend rather than request count. Both are real and they disagree,
            // so both are shown with their own labels rather than picking a winner.
            if let percent = num(plan, "totalPercentUsed") {
                reading.windows.append(LimitWindow(
                    id: "cursor-included", label: "Included usage",
                    usedFraction: percent / 100, resetsAt: cycleEnd, windowMinutes: nil
                ))
            }
            if let onDemand = dict(dict(summary, "individualUsage"), "onDemand"),
               (onDemand["enabled"] as? NSNumber)?.boolValue == true,
               let limit = num(onDemand, "limit"), limit > 0,
               let remaining = num(onDemand, "remaining") {
                reading.windows.append(LimitWindow(
                    id: "cursor-ondemand", label: "On-demand",
                    usedFraction: 1 - remaining / limit, resetsAt: cycleEnd, windowMinutes: nil
                ))
            }
            if (summary["isUnlimited"] as? NSNumber)?.boolValue == true {
                reading.detail = "unlimited plan"
            }
        }

        // A weekly window that resets independently of the billing cycle.
        if let sand, let percent = num(sand, "usagePercent") {
            reading.windows.append(LimitWindow(
                id: "cursor-week", label: "Weekly",
                usedFraction: percent / 100,
                resetsAt: str(sand, "nextResetTimestampUtc").flatMap(ISO8601.parse),
                windowMinutes: 10_080
            ))
        }

        if let events {
            result.events = Int(num(events, "totalUsageEventsCount") ?? 0)
            var byModel: [String: ModelTotal] = [:]
            var newest: Date?
            for entry in (events["usageEventsDisplay"] as? [[String: Any]] ?? []) {
                let model = str(entry, "model") ?? "unknown"
                let usage = dict(entry, "tokenUsage")
                let counts = TokenCounts(
                    input: Int(num(usage, "inputTokens") ?? 0),
                    output: Int(num(usage, "outputTokens") ?? 0),
                    cacheRead: Int(num(usage, "cacheReadTokens") ?? 0),
                    cacheWrite: Int(num(usage, "cacheWriteTokens") ?? 0)
                )
                // Cursor bills in cents, including fractional ones.
                let cost = (num(entry, "chargedCents") ?? num(usage, "totalCents") ?? 0) / 100
                var total = byModel[model] ?? ModelTotal(model: model, tokens: TokenCounts(), costUSD: 0, messages: 0)
                total.tokens += counts
                total.costUSD += cost
                total.messages += 1
                byModel[model] = total

                result.tokens += counts
                result.costUSD += cost
                // Milliseconds, delivered as a string.
                if let stamp = Double(str(entry, "timestamp") ?? "") {
                    let date = Date(timeIntervalSince1970: stamp / 1000)
                    if date > (newest ?? .distantPast) { newest = date }
                }
            }
            result.models = byModel.values.sorted { $0.tokens.total > $1.tokens.total }
            result.lastActivity = newest
        }

        // Least headroom first so the row headlines whichever is closest to running out.
        reading.windows.sort { $0.remainingFraction < $1.remainingFraction }
        result.reading = reading
        return result
    }

    private func call(_ path: String, method: String, token: String) async -> [String: Any]? {
        guard let url = URL(string: "https://cursor.com/api/\(path)") else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 12
        request.setValue("WorkosCursorSessionToken=\(token)", forHTTPHeaderField: "Cookie")
        request.setValue("Mozilla/5.0", forHTTPHeaderField: "User-Agent")
        // Without these the dashboard endpoints answer 403 even with a valid session.
        request.setValue("https://cursor.com", forHTTPHeaderField: "Origin")
        request.setValue("https://cursor.com/dashboard", forHTTPHeaderField: "Referer")
        if method == "POST" {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = Data("{}".utf8)
        }
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
