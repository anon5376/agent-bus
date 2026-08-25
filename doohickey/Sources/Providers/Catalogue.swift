import Foundation
import SwiftUI

/// Every provider Doohickey knows about.
///
/// Three tiers, and the UI keeps them apart on purpose:
///
/// - **Quota APIs.** The provider states how much is left. These are the only ones
///   where "% remaining" is a fact rather than a reconstruction.
/// - **Local transcripts.** No usage API exists, but the tool writes token counts to
///   disk (Codex, Claude Code). Tokens are exact; any quota figure is inferred.
/// - **No usage surface at all.** Listed so the roster is honest about why they are
///   missing, instead of looking like something the user forgot to set up.
enum Catalogue {
    static let hue = (
        anthropic: Color(red: 0.85, green: 0.47, blue: 0.30),
        openai: Color(red: 0.32, green: 0.72, blue: 0.60),
        router: Color(red: 0.45, green: 0.55, blue: 0.92),
        bus: Color(red: 0.72, green: 0.50, blue: 0.86),
        cursor: Color(red: 0.42, green: 0.45, blue: 0.50),
        grok: Color(red: 0.20, green: 0.20, blue: 0.22),
        moon: Color(red: 0.36, green: 0.36, blue: 0.85),
        deep: Color(red: 0.29, green: 0.47, blue: 0.90),
        qwen: Color(red: 0.85, green: 0.35, blue: 0.42),
        local: Color(red: 0.50, green: 0.55, blue: 0.60),
        misc: Color(red: 0.55, green: 0.60, blue: 0.68)
    )

    // MARK: - Providers with a real quota or balance endpoint

    static let apiBacked: [ProviderSpec] = [
        ProviderSpec(
            id: "openrouter",
            title: "OpenRouter",
            symbol: "arrow.triangle.branch",
            accent: hue.router,
            credentials: [.keyFile("~/.openrouter-key"), .env("OPENROUTER_API_KEY")],
            endpoint: QuotaEndpoint(url: "https://openrouter.ai/api/v1/key") { json in
                let data = dict(json, "data")
                var reading = Reading()
                reading.usedUSD = num(data, "usage")
                reading.limitUSD = num(data, "limit")
                // `limit` is null on an unlimited or pay-as-you-go key; there is then no
                // fraction to draw, only a running total.
                if let limit = reading.limitUSD, limit > 0 {
                    let remaining = num(data, "limit_remaining") ?? max(0, limit - (reading.usedUSD ?? 0))
                    reading.balanceUSD = remaining
                    reading.windows = [LimitWindow(
                        id: "openrouter-credit", label: "Credit",
                        usedFraction: 1 - remaining / limit, resetsAt: nil, windowMinutes: nil
                    )]
                }
                let free = (data?["is_free_tier"] as? NSNumber)?.boolValue ?? false
                reading.plan = free ? "free tier" : "paid"
                if let weekly = num(data, "usage_weekly") {
                    reading.detail = "$\(String(format: "%.2f", weekly)) this week"
                }
                return reading
            }
        ),

        ProviderSpec(
            id: "deepseek",
            title: "DeepSeek",
            symbol: "water.waves",
            accent: hue.deep,
            credentials: [.keyFile("~/.deepseek-key"), .env("DEEPSEEK_API_KEY")],
            endpoint: QuotaEndpoint(url: "https://api.deepseek.com/user/balance") { json in
                guard let infos = json["balance_infos"] as? [[String: Any]], let first = infos.first
                else { return nil }
                var reading = Reading()
                // Returned as a decimal string, not a number.
                reading.balanceUSD = Double(str(first, "total_balance") ?? "") ?? 0
                let granted = Double(str(first, "granted_balance") ?? "") ?? 0
                let topped = Double(str(first, "topped_up_balance") ?? "") ?? 0
                reading.detail = "granted $\(String(format: "%.2f", granted)) · topped up $\(String(format: "%.2f", topped))"
                reading.plan = str(first, "currency")
                return reading
            }
        ),

        ProviderSpec(
            id: "moonshot",
            title: "Moonshot",
            symbol: "moon.stars",
            accent: hue.moon,
            credentials: [.keyFile("~/.moonshot-key"), .env("MOONSHOT_API_KEY")],
            endpoint: QuotaEndpoint(url: "https://api.moonshot.cn/v1/users/me/balance") { json in
                let data = dict(json, "data")
                var reading = Reading()
                reading.balanceUSD = num(data, "available_balance")
                if let cash = num(data, "cash_balance"), let voucher = num(data, "voucher_balance") {
                    reading.detail = "cash $\(String(format: "%.2f", cash)) · voucher $\(String(format: "%.2f", voucher))"
                }
                return reading
            }
        ),

        ProviderSpec(
            id: "novita",
            title: "Novita",
            symbol: "sparkles",
            accent: hue.misc,
            credentials: [.keyFile("~/.config/opencode/.novita-key"), .env("NOVITA_API_KEY")],
            endpoint: QuotaEndpoint(url: "https://api.novita.ai/v3/user") { json in
                var reading = Reading()
                // `credit_balance` is an integer in an undocumented minor unit. Rather
                // than guess a divisor and print a confident dollar figure that could be
                // off by 10x, it is reported as credits. A negative value means the
                // account is in arrears.
                guard let credits = num(json, "credit_balance")
                    ?? Double(str(json, "credit_balance") ?? "") else { return nil }
                reading.plan = credits < 0 ? "in arrears" : "active"
                reading.detail = "\(Int(credits)) credits"
                return reading
            }
        ),

        ProviderSpec(
            id: "siliconflow",
            title: "SiliconFlow",
            symbol: "cpu",
            accent: hue.misc,
            credentials: [.keyFile("~/.siliconflow-key"), .env("SILICONFLOW_API_KEY")],
            endpoint: QuotaEndpoint(url: "https://api.siliconflow.cn/v1/user/info") { json in
                let data = dict(json, "data")
                var reading = Reading()
                reading.balanceUSD = Double(str(data, "totalBalance") ?? "") ?? num(data, "totalBalance")
                reading.plan = str(data, "status")
                return reading
            }
        ),

        ProviderSpec(
            id: "xai",
            title: "xAI",
            symbol: "x.circle",
            accent: hue.grok,
            credentials: [.keyFile("~/.xai-key"), .env("XAI_API_KEY")],
            endpoint: QuotaEndpoint(url: "https://api.x.ai/v1/api-key") { json in
                var reading = Reading()
                // xAI publishes key state, not spend. Worth showing that the key is live
                // and unblocked; anything more would be invented.
                let blocked = (json["api_key_blocked"] as? NSNumber)?.boolValue ?? false
                let disabled = (json["api_key_disabled"] as? NSNumber)?.boolValue ?? false
                reading.plan = blocked || disabled ? "key blocked" : "key active"
                reading.detail = "no spend endpoint — tokens counted locally"
                return reading
            }
        ),

        ProviderSpec(
            id: "grok",
            title: "Grok",
            symbol: "bolt.horizontal",
            accent: hue.grok,
            // grok.com authenticates with browser session cookies, which this app has no
            // business reading out of a browser profile. Drop the `sso` cookie value into
            // this file to enable it.
            credentials: [.keyFile("~/.grok-session"), .env("GROK_SSO_COOKIE")],
            endpoint: QuotaEndpoint(
                url: "https://grok.com/rest/rate-limits",
                method: "POST",
                auth: .cookie("sso"),
                body: #"{"requestKind":"DEFAULT","modelName":"grok-4"}"#
            ) { json in
                var reading = Reading()
                guard let remaining = num(json, "remainingQueries") else { return nil }
                let total = num(json, "totalQueries") ?? remaining
                reading.windows = [LimitWindow(
                    id: "grok-window",
                    label: "Queries",
                    usedFraction: total > 0 ? 1 - remaining / total : 0,
                    resetsAt: num(json, "windowSizeSeconds").map { Date().addingTimeInterval($0) },
                    windowMinutes: num(json, "windowSizeSeconds").map { Int($0 / 60) }
                )]
                reading.detail = "\(Int(remaining)) of \(Int(total)) queries left"
                return reading
            },
            billing: .subscription
        ),

        ProviderSpec(
            id: "zai",
            title: "Z.ai",
            symbol: "z.square",
            accent: hue.qwen,
            credentials: [.keyFile("~/.zai-key"), .env("ZAI_API_KEY"), .env("ZHIPU_API_KEY")],
            endpoint: QuotaEndpoint(url: "https://api.z.ai/api/paas/v4/models") { _ in
                var reading = Reading()
                reading.plan = "key active"
                reading.detail = "no balance endpoint — tokens counted locally"
                return reading
            }
        ),
    ]

    // MARK: - Subscription products reached through their session, not an API key

    static let cursor = ProviderSpec(
        id: "cursor",
        title: "Cursor",
        symbol: "cursorarrow.rays",
        accent: hue.cursor,
        credentials: [
            .cookie(path: "~/Library/Application Support/CodexBar/cursor-session.json",
                    name: "WorkosCursorSessionToken"),
            .keyFile("~/.cursor-session"),
        ],
        billing: .subscription
    )

    // MARK: - Known, but nothing to report

    /// Listed in the roster with an accurate reason.
    ///
    /// An earlier version wrote "no balance endpoint" against most of these. That was
    /// wrong: they do publish usage, just behind a *console web session* rather than an
    /// API key, so the blocker is credential shape, not the absence of an endpoint.
    /// Each carries the path it would read, so wiring one up is a matter of dropping the
    /// session cookie in place.
    static let unsupported: [ProviderSpec] = [
        ProviderSpec(id: "openai-api", title: "OpenAI API", symbol: "circle.hexagongrid",
                     accent: hue.openai, credentials: [.env("OPENAI_API_KEY")],
                     publishesUsage: false,
                     note: "org costs need an admin key"),
        ProviderSpec(id: "groq", title: "Groq", symbol: "bolt", accent: hue.misc,
                     credentials: [.keyFile("~/.groq-session"), .env("GROQ_API_KEY")],
                     publishesUsage: false,
                     note: "usage is console-session only"),
        ProviderSpec(id: "mistral", title: "Mistral", symbol: "wind", accent: hue.misc,
                     credentials: [.keyFile("~/.mistral-session"), .env("MISTRAL_API_KEY")],
                     publishesUsage: false,
                     note: "usage is console-session only"),
        ProviderSpec(id: "together", title: "Together", symbol: "person.2", accent: hue.misc,
                     credentials: [.env("TOGETHER_API_KEY")],
                     publishesUsage: false, note: "no public balance endpoint"),
        ProviderSpec(id: "fireworks", title: "Fireworks", symbol: "flame", accent: hue.misc,
                     credentials: [.env("FIREWORKS_API_KEY")],
                     publishesUsage: false, note: "needs an account id as well as a key"),
        ProviderSpec(id: "gemini", title: "Gemini", symbol: "sparkle", accent: hue.misc,
                     credentials: [.jsonField(path: "~/.gemini/oauth_creds.json", keyPath: ["access_token"])],
                     publishesUsage: false, note: "quota lives in the Cloud console"),
        ProviderSpec(id: "copilot", title: "Copilot", symbol: "chevron.left.slash.chevron.right",
                     accent: hue.misc, credentials: [.jsonField(path: "~/.copilot/config.json", keyPath: ["token"])],
                     publishesUsage: false, note: "no per-account usage endpoint"),
    ]

    /// Local runtimes: unlimited by construction, so they get a row only when running.
    static let ollama = ProviderSpec(
        id: "ollama", title: "Ollama", symbol: "desktopcomputer", accent: hue.local,
        billing: .metered
    )
}
