import Foundation
import SwiftUI

/// Talks to the agent-bus broker over localhost HTTP and republishes everything
/// as observable state for the UI. Polls a single /snapshot endpoint so roster,
/// tasks and new messages always arrive as one consistent picture.
@MainActor
final class BusClient: ObservableObject {
    @Published var roster: [RosterEntry] = []
    @Published var tasks: [BusTask] = []
    @Published var messages: [BusMessage] = []
    @Published var connected = false
    @Published var brokerPid: Int = 0
    @Published var lastError: String?
    @Published var starting = false
    @Published var busy = false

    /// Identity the GUI acts as. Its token is minted by the broker and read from a
    /// 0600 file, so the panel can only ever speak as the operator — never as an agent.
    static let operatorId = "operator"

    private var operatorToken: String {
        let path = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".agent-bus/operator.token")
        return (try? String(contentsOf: path, encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    private var cursor = 0
    private var pollTask: Task<Void, Never>?
    private let base = URL(string: "http://127.0.0.1:11511")!
    private let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 8
        return URLSession(configuration: c)
    }()

    // MARK: - polling

    func start() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.poll()
                try? await Task.sleep(nanoseconds: 700_000_000)
            }
        }
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    private func poll() async {
        do {
            let snap: Snapshot = try await post("/snapshot", ["sinceSeq": cursor])
            // A broker restart rewinds the counter; drop our stale view.
            if snap.seq < cursor {
                messages.removeAll()
                cursor = 0
            }
            roster = snap.roster
            tasks = snap.tasks
            brokerPid = snap.brokerPid
            if !snap.messages.isEmpty {
                messages.append(contentsOf: snap.messages)
                cursor = snap.messages.map(\.seq).max() ?? cursor
                if messages.count > 5000 {
                    messages.removeFirst(messages.count - 5000)
                }
            }
            connected = true
            lastError = nil
            let tok = operatorToken
            if !tok.isEmpty {
                // Refresh operator presence and keep our own mailbox drained; the
                // full history still shows every message in the stream.
                _ = try? await postRaw("/status", ["token": tok, "status": "idle"])
                _ = try? await postRaw("/peek", ["token": tok])
            }
        } catch {
            connected = false
            lastError = (error as NSError).code == -1004
                ? "broker not running"
                : error.localizedDescription
        }
    }

    // MARK: - agents the operator may address

    var knownAgents: [KnownAgent] {
        roster
            .filter { $0.id != Self.operatorId }
            .map { KnownAgent(id: $0.id, running: $0.isRunning) }
    }

    // MARK: - actions (always as the operator)

    func send(to: String, subject: String, body: String, type: String) async {
        await act("/send", ["to": to, "subject": subject, "body": body, "type": type])
    }

    func assignTask(to: String, title: String, brief: String, context: String) async {
        await act("/task/create", [
            "assignee": to, "title": title, "brief": brief, "context": context,
        ])
    }

    func review(taskId: String, accepted: Bool, feedback: String) async {
        await act("/task/review", [
            "taskId": taskId, "accepted": accepted, "feedback": feedback,
        ])
    }

    func cancel(taskId: String, reason: String) async {
        await act("/task/cancel", ["taskId": taskId, "reason": reason])
    }

    /// Stop the supervisor process group holding one agent (the kill switch).
    func killAgent(_ id: String) async {
        await act("/kill", ["agentId": id])
    }

    // MARK: - open an agent's session in Terminal

    private var home: String { NSHomeDirectory() }

    /// Open the agent's readable transcript (its full request/response history) in
    /// Terminal via a pager. This is the "see the chat history" action.
    func openHistory(_ id: String) {
        let tf = "\(home)/.agent-bus/transcripts/\(id).md"
        openInTerminal(name: "\(id)-history", script: """
        TF="\(tf)"
        if [ -f "$TF" ]; then
          printf '\\033]0;%s\\007' "\(id) — history"
          exec less +G -R "$TF"
        else
          echo "No transcript yet for \(id) — it hasn't run a turn."
          echo "Press any key to close."; read -n1 -s
        fi
        """)
    }

    /// Open the agent's live CLI session in Terminal, resuming its most recent
    /// conversation in its working directory — so you can read or continue it.
    func openLiveSession(_ agent: RosterEntry) {
        guard let wd = agent.workdir, !wd.isEmpty else { return }
        let resume: String
        switch agent.cli {
        case "claude":  resume = "claude --continue"
        case "codex":   resume = "codex resume --last"
        case "grok":    resume = "grok --continue"
        case "kimi":    resume = "kimi -c"
        case "opencode": resume = "opencode --continue"
        default:        resume = "echo 'no resume command known for \(agent.cli ?? "?")'; $SHELL"
        }
        openInTerminal(name: "\(agent.id)-session", script: """
        cd "\(wd)" || exit 1
        printf '\\033]0;%s\\007' "\(agent.id) — live session"
        echo "Resuming \(agent.id)'s session in \(wd)"
        \(resume)
        """)
    }

    /// Write a .command script and open it — Terminal runs it, no automation prompt.
    private func openInTerminal(name: String, script: String) {
        let dir = "\(home)/.agent-bus/open"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let path = "\(dir)/\(name).command"
        let body = "#!/bin/bash\n\(script)\n"
        do {
            try body.write(toFile: path, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: path)
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            p.arguments = [path]
            try p.run()
        } catch {
            lastError = "could not open terminal: \(error.localizedDescription)"
        }
    }

    /// Emergency stop: kill every supervised agent still running.
    func stopAll() async {
        let running = roster.filter { $0.isRunning }.map(\.id)
        for id in running {
            _ = try? await postRaw("/kill", ["token": operatorToken, "agentId": id])
        }
        await poll()
    }

    private func act(_ path: String, _ body: [String: Any]) async {
        busy = true
        defer { busy = false }
        do {
            var b = body
            b["token"] = operatorToken
            _ = try await postRaw(path, b)
            await poll()
        } catch {
            lastError = error.localizedDescription
        }
    }

    // MARK: - broker lifecycle

    /// Launch the broker daemon from the GUI when it isn't already up.
    func startBroker(nodePath: String, cliPath: String) {
        starting = true
        let proc = Process()
        proc.executableURL = URL(fileURLToPath: nodePath)
        proc.arguments = [cliPath, "broker"]
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
        } catch {
            lastError = "could not start broker: \(error.localizedDescription)"
        }
        Task {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            starting = false
            await poll()
        }
    }

    // MARK: - transport

    @discardableResult
    private func postRaw(_ path: String, _ body: [String: Any]) async throws -> Data {
        var req = URLRequest(url: base.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await session.data(for: req)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            let text = String(data: data, encoding: .utf8) ?? "\(http.statusCode)"
            throw NSError(domain: "agent-bus", code: http.statusCode,
                          userInfo: [NSLocalizedDescriptionKey: text])
        }
        return data
    }

    private func post<T: Decodable>(_ path: String, _ body: [String: Any]) async throws -> T {
        try JSONDecoder().decode(T.self, from: try await postRaw(path, body))
    }
}

private extension URL {
    init(fileURLToPath path: String) {
        self.init(fileURLWithPath: path)
    }
}
