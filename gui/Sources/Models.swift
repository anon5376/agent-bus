import Foundation
import SwiftUI

/// One restrained palette for the whole app. A handful of semantic colours only —
/// status means something, everything else is neutral. This is the deliberate
/// opposite of a different accent per message type.
enum Palette {
    static let accent = Color(red: 0.30, green: 0.42, blue: 0.86)   // one blue, used sparingly
    static let ok = Color(red: 0.24, green: 0.62, blue: 0.36)       // running / accepted
    static let active = Color(red: 0.82, green: 0.55, blue: 0.15)   // working
    static let waiting = Color.secondary                            // idle/parked = quiet
    static let danger = Color(red: 0.80, green: 0.25, blue: 0.24)   // stalled / stop
    static let muted = Color.secondary.opacity(0.55)
}

struct BusMessage: Codable, Identifiable, Hashable {
    let id: String
    let seq: Int
    let ts: Double
    let from: String
    let to: String
    let type: String
    let subject: String
    let body: String
    let taskId: String?

    var date: Date { Date(timeIntervalSince1970: ts / 1000) }

    /// Almost everything is neutral. Only the two states a human must not miss get
    /// a colour: a rejection asking for changes, and a question awaiting an answer.
    var accent: Color {
        switch type {
        case "feedback": return Palette.active
        case "question": return Palette.accent
        default: return Palette.muted
        }
    }
}

struct BusTaskEvent: Codable, Hashable {
    let ts: Double
    let actor: String
    let kind: String
    let state: String
    let note: String

    var date: Date { Date(timeIntervalSince1970: ts / 1000) }
}

struct BusTask: Codable, Identifiable, Hashable {
    let id: String
    let title: String
    let brief: String
    let context: String
    let assigner: String
    let assignee: String
    let state: String
    let round: Int
    let createdAt: Double
    let updatedAt: Double
    let history: [BusTaskEvent]

    var isOpen: Bool { state != "accepted" && state != "cancelled" }

    var accent: Color {
        switch state {
        case "submitted": return Palette.accent        // needs your review
        case "changes_requested": return Palette.active
        case "accepted": return Palette.ok
        case "cancelled": return Palette.muted
        default: return Palette.waiting
        }
    }

    var stateLabel: String { state.replacingOccurrences(of: "_", with: " ") }
}

struct RosterEntry: Codable, Identifiable, Hashable {
    let id: String
    let role: String
    let model: String
    let description: String
    let status: String
    let currentTaskId: String?
    let pendingMessages: Int
    let lastSeenSecondsAgo: Int
    let blocked: Bool
    let stalled: Bool
    /** pid of the supervisor daemon holding this agent — nil if not supervised. */
    let supervisorPid: Int?
    /** where/how this agent runs, for opening its session in a terminal. */
    let workdir: String?
    let cli: String?

    /** A live supervisor process is holding this agent — it can be stopped. */
    var isRunning: Bool { (supervisorPid ?? 0) > 0 }

    var dot: Color {
        if stalled { return Palette.danger }
        switch status {
        case "working": return Palette.active
        case "waiting": return Palette.waiting
        case "idle": return isRunning ? Palette.ok : Palette.muted
        default: return Palette.muted
        }
    }

    var statusLabel: String {
        if stalled { return "stalled — unread mail, no one listening" }
        if status == "working" { return "working" }
        if blocked || status == "waiting" { return "waiting for messages" }
        return status
    }
}

struct Snapshot: Codable {
    let roster: [RosterEntry]
    let tasks: [BusTask]
    let messages: [BusMessage]
    let seq: Int
    let waiting: [String]
    let brokerPid: Int
}

/// Agents the operator may address, and their supervised/running state. Built by
/// the view from the roster; the human never picks a *sender*, only a recipient.
struct KnownAgent: Identifiable, Hashable {
    let id: String
    let running: Bool
}

enum Fmt {
    static let clock: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f
    }()

    static func ago(_ seconds: Int) -> String {
        if seconds < 60 { return "\(seconds)s" }
        if seconds < 3600 { return "\(seconds / 60)m" }
        return "\(seconds / 3600)h"
    }
}
