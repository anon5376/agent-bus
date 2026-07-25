import SwiftUI

struct ContentView: View {
    @EnvironmentObject var bus: BusClient
    @State private var selectedAgent: String?
    @State private var search = ""
    @State private var inspectedTask: BusTask?
    @State private var showClosedTasks = false
    @State private var confirmStopAll = false

    var body: some View {
        VStack(spacing: 0) {
            TopBar(confirmStopAll: $confirmStopAll)
            Divider()
            if bus.connected {
                StalledBanner()
                mainPanes
                Divider()
                ComposeBar(presetTo: selectedAgent)
            } else {
                DisconnectedView()
            }
        }
        .frame(minWidth: 1120, minHeight: 700)
        .sheet(item: $inspectedTask) { TaskDetailSheet(task: $0) }
        .confirmationDialog(
            "Stop every running agent?",
            isPresented: $confirmStopAll, titleVisibility: .visible
        ) {
            Button("Stop all agents", role: .destructive) {
                Task { await bus.stopAll() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Kills each supervisor process. The broker and this window stay open so you keep the full history.")
        }
    }

    private var mainPanes: some View {
        HSplitView {
            AgentPane(selectedAgent: $selectedAgent)
                .frame(minWidth: 248, idealWidth: 274, maxWidth: 360)
            MessageStream(messages: filteredMessages, search: $search,
                          selectedAgent: $selectedAgent)
                .frame(minWidth: 440)
            TaskPane(showClosed: $showClosedTasks, inspected: $inspectedTask)
                .frame(minWidth: 268, idealWidth: 320, maxWidth: 430)
        }
    }

    private var filteredMessages: [BusMessage] {
        bus.messages.filter { m in
            let agentOK = selectedAgent.map { m.from == $0 || m.to == $0 } ?? true
            guard agentOK else { return false }
            guard !search.isEmpty else { return true }
            let q = search.lowercased()
            return m.subject.lowercased().contains(q) || m.body.lowercased().contains(q)
                || m.from.lowercased().contains(q) || m.to.lowercased().contains(q)
        }
    }
}

// MARK: - shared style

enum UI {
    static let card = Color(nsColor: .controlBackgroundColor)
    static let hairline = Color.primary.opacity(0.08)

    @ViewBuilder
    static func panelHeader(_ title: String, trailing: AnyView? = nil) -> some View {
        HStack {
            Text(title.uppercased())
                .font(.system(size: 10.5, weight: .semibold))
                .tracking(0.6)
                .foregroundStyle(.secondary)
            Spacer()
            if let trailing { trailing }
        }
        .padding(.horizontal, 14).padding(.vertical, 9)
    }
}

struct Pill: View {
    let text: String
    var color: Color = .secondary
    var body: some View {
        Text(text)
            .font(.system(size: 9.5, weight: .medium))
            .tracking(0.3)
            .foregroundStyle(color)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(color.opacity(0.12), in: Capsule())
    }
}

// MARK: - top bar

struct TopBar: View {
    @EnvironmentObject var bus: BusClient
    @Binding var confirmStopAll: Bool

    private var runningCount: Int { bus.roster.filter(\.isRunning).count }

    var body: some View {
        HStack(spacing: 10) {
            Circle().fill(bus.connected ? Palette.ok : Palette.danger)
                .frame(width: 8, height: 8)
            Text("agent-bus").font(.system(size: 13, weight: .semibold))
            Text(bus.connected ? "connected · pid \(bus.brokerPid)"
                               : (bus.lastError ?? "disconnected"))
                .font(.system(size: 11)).foregroundStyle(.secondary)

            Spacer()

            if bus.connected {
                metric("\(runningCount) running", highlight: runningCount > 0)
                metric("\(bus.tasks.filter(\.isOpen).count) open tasks")
                metric("\(bus.messages.count) messages")
                Button(role: .destructive) { confirmStopAll = true } label: {
                    Label("Stop all", systemImage: "stop.fill")
                        .font(.system(size: 11, weight: .semibold))
                }
                .buttonStyle(.borderedProminent).tint(Palette.danger)
                .disabled(runningCount == 0)
                .help("Kill every running agent supervisor")
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }

    private func metric(_ s: String, highlight: Bool = false) -> some View {
        Text(s).font(.system(size: 11))
            .foregroundStyle(highlight ? AnyShapeStyle(Palette.ok) : AnyShapeStyle(.secondary))
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(UI.card, in: Capsule())
    }
}

struct DisconnectedView: View {
    @EnvironmentObject var bus: BusClient
    var body: some View {
        VStack(spacing: 14) {
            Spacer()
            Image(systemName: "circle.dotted").font(.system(size: 40)).foregroundStyle(.tertiary)
            Text("Broker not running").font(.title3.weight(.medium))
            if let e = bus.lastError {
                Text(e).font(.callout).foregroundStyle(.secondary)
            }
            Button(bus.starting ? "Starting…" : "Start broker") {
                bus.startBroker(nodePath: AppPaths.node, cliPath: AppPaths.cli)
            }
            .disabled(bus.starting).buttonStyle(.borderedProminent)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - stalled banner

struct StalledBanner: View {
    @EnvironmentObject var bus: BusClient
    private var stalled: [RosterEntry] { bus.roster.filter(\.stalled) }
    var body: some View {
        if !stalled.isEmpty {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 11))
                Text(stalled.map(\.id).joined(separator: ", ")).fontWeight(.semibold)
                Text(stalled.count == 1 ? "has unread mail and no one listening."
                                        : "have unread mail and no one listening.")
                Spacer()
            }
            .font(.system(size: 11)).foregroundStyle(Palette.danger)
            .padding(.horizontal, 14).padding(.vertical, 7)
            .background(Palette.danger.opacity(0.10))
            .overlay(alignment: .bottom) { Rectangle().fill(UI.hairline).frame(height: 1) }
        }
    }
}

// MARK: - agents pane (monitor + kill)

struct AgentPane: View {
    @EnvironmentObject var bus: BusClient
    @Binding var selectedAgent: String?

    private var agents: [RosterEntry] {
        bus.roster.filter { $0.id != BusClient.operatorId }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            UI.panelHeader("Agents", trailing: selectedAgent != nil
                ? AnyView(Button("clear filter") { selectedAgent = nil }
                    .buttonStyle(.link).font(.system(size: 10.5)))
                : nil)
            Rectangle().fill(UI.hairline).frame(height: 1)
            ScrollView {
                LazyVStack(spacing: 6) {
                    ForEach(agents) { agent in
                        AgentRow(agent: agent, selected: selectedAgent == agent.id)
                            .onTapGesture {
                                selectedAgent = selectedAgent == agent.id ? nil : agent.id
                            }
                    }
                    if agents.isEmpty {
                        Text("No agents yet.\nStart some with scripts/start.sh.")
                            .font(.system(size: 11)).foregroundStyle(.secondary)
                            .multilineTextAlignment(.center).padding(.top, 28)
                    }
                }
                .padding(10)
            }
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }
}

struct AgentRow: View {
    @EnvironmentObject var bus: BusClient
    let agent: RosterEntry
    let selected: Bool
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Circle().fill(agent.dot).frame(width: 7, height: 7)
                Text(agent.id).font(.system(size: 12.5, weight: .semibold))
                Pill(text: agent.role)
                Spacer()
                if agent.pendingMessages > 0 {
                    Pill(text: "\(agent.pendingMessages)", color: Palette.accent)
                }
            }
            HStack(spacing: 6) {
                Text(agent.statusLabel).font(.system(size: 10.5)).foregroundStyle(agent.dot)
                if let t = agent.currentTaskId {
                    Text("· \(t)").font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.tertiary).lineLimit(1)
                }
            }
            HStack(spacing: 8) {
                Text(agent.isRunning ? "supervisor · pid \(agent.supervisorPid!)" : "not supervised")
                    .font(.system(size: 9.5, design: .monospaced)).foregroundStyle(.tertiary)
                Spacer()
                if agent.isRunning {
                    Button { Task { await bus.killAgent(agent.id) } } label: {
                        Text("Stop").font(.system(size: 10, weight: .medium))
                    }
                    .buttonStyle(.borderless).foregroundStyle(Palette.danger)
                    .opacity(hovering || selected ? 1 : 0.5)
                    .help("Kill \(agent.id)'s supervisor process")
                }
            }
            HStack(spacing: 10) {
                Button { bus.openHistory(agent.id) } label: {
                    Label("History", systemImage: "text.bubble")
                        .font(.system(size: 10)).labelStyle(.titleAndIcon)
                }
                .buttonStyle(.borderless).foregroundStyle(Palette.accent)
                .help("Open \(agent.id)'s full request/response transcript in Terminal")

                if agent.workdir != nil && !(agent.workdir ?? "").isEmpty {
                    Button { bus.openLiveSession(agent) } label: {
                        Label("Session", systemImage: "terminal")
                            .font(.system(size: 10)).labelStyle(.titleAndIcon)
                    }
                    .buttonStyle(.borderless).foregroundStyle(.secondary)
                    .help("Open \(agent.id)'s live CLI session in Terminal (resume its conversation)")
                }
                Spacer()
                Text("\(agent.model) · \(Fmt.ago(agent.lastSeenSecondsAgo)) ago")
                    .font(.system(size: 9.5)).foregroundStyle(.tertiary).lineLimit(1)
            }
            .opacity(hovering || selected ? 1 : 0.72)
        }
        .padding(10)
        .background(selected ? Palette.accent.opacity(0.10) : UI.card,
                    in: RoundedRectangle(cornerRadius: 8))
        .overlay {
            RoundedRectangle(cornerRadius: 8)
                .stroke(selected ? Palette.accent.opacity(0.4)
                        : (agent.stalled ? Palette.danger.opacity(0.4) : UI.hairline),
                        lineWidth: 1)
        }
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
    }
}

// MARK: - message stream (newest first)

struct MessageStream: View {
    let messages: [BusMessage]
    @Binding var search: String
    @Binding var selectedAgent: String?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").font(.system(size: 10)).foregroundStyle(.tertiary)
                TextField("Filter messages", text: $search)
                    .textFieldStyle(.plain).font(.system(size: 11.5))
                if let a = selectedAgent { Pill(text: a, color: Palette.accent) }
                Text("newest first").font(.system(size: 10)).foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 14).padding(.vertical, 9)
            Rectangle().fill(UI.hairline).frame(height: 1)

            ScrollView {
                LazyVStack(spacing: 8) {
                    ForEach(messages.reversed()) { MessageCard(message: $0) }
                    if messages.isEmpty {
                        Text("No messages.").font(.system(size: 11))
                            .foregroundStyle(.secondary).padding(.top, 30)
                    }
                }
                .padding(12)
            }
        }
        .background(Color(nsColor: .textBackgroundColor).opacity(0.4))
    }
}

struct MessageCard: View {
    let message: BusMessage
    @State private var expanded = false
    private var isLong: Bool { message.body.count > 360 }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(message.from).font(.system(size: 11.5, weight: .semibold))
                Image(systemName: "arrow.right").font(.system(size: 8)).foregroundStyle(.tertiary)
                Text(message.to).font(.system(size: 11.5))
                Text(message.type).font(.system(size: 9.5, weight: .medium))
                    .foregroundStyle(message.accent)
                if let t = message.taskId {
                    Text(t).font(.system(size: 9.5, design: .monospaced)).foregroundStyle(.tertiary)
                }
                Spacer()
                Text(Fmt.clock.string(from: message.date))
                    .font(.system(size: 10, design: .monospaced)).foregroundStyle(.tertiary)
            }
            if !message.subject.isEmpty {
                Text(message.subject).font(.system(size: 12.5, weight: .medium))
            }
            Text(expanded || !isLong ? message.body : String(message.body.prefix(360)) + "…")
                .font(.system(size: 12)).foregroundStyle(.secondary)
                .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                .lineSpacing(1.5)
            if isLong {
                Button(expanded ? "Show less" : "Show more") { expanded.toggle() }
                    .buttonStyle(.link).font(.system(size: 10.5))
            }
        }
        .padding(11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(UI.card, in: RoundedRectangle(cornerRadius: 8))
        .overlay(alignment: .leading) {
            RoundedRectangle(cornerRadius: 2)
                .fill(message.accent).frame(width: 2.5).padding(.vertical, 10)
        }
    }
}

// MARK: - tasks pane

struct TaskPane: View {
    @EnvironmentObject var bus: BusClient
    @Binding var showClosed: Bool
    @Binding var inspected: BusTask?

    private var shown: [BusTask] { showClosed ? bus.tasks : bus.tasks.filter(\.isOpen) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            UI.panelHeader("Tasks", trailing: AnyView(
                Toggle("closed", isOn: $showClosed)
                    .toggleStyle(.checkbox).font(.system(size: 10.5))))
            Rectangle().fill(UI.hairline).frame(height: 1)
            ScrollView {
                LazyVStack(spacing: 6) {
                    ForEach(shown) { task in
                        TaskRow(task: task).onTapGesture { inspected = task }
                    }
                    if shown.isEmpty {
                        Text("No tasks.").font(.system(size: 11))
                            .foregroundStyle(.secondary).padding(.top, 26)
                    }
                }
                .padding(10)
            }
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }
}

struct TaskRow: View {
    let task: BusTask
    @State private var hovering = false
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Pill(text: task.stateLabel, color: task.accent)
                Spacer()
                Text("round \(task.round)").font(.system(size: 9.5, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }
            Text(task.title).font(.system(size: 12.5, weight: .medium)).lineLimit(2)
            HStack(spacing: 5) {
                Text(task.assigner).font(.system(size: 10.5, weight: .medium))
                Image(systemName: "arrow.right").font(.system(size: 8)).foregroundStyle(.tertiary)
                Text(task.assignee).font(.system(size: 10.5))
                Spacer()
                Text(task.id).font(.system(size: 9.5, design: .monospaced)).foregroundStyle(.tertiary)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(hovering ? Palette.accent.opacity(0.06) : UI.card,
                    in: RoundedRectangle(cornerRadius: 8))
        .overlay { RoundedRectangle(cornerRadius: 8).stroke(UI.hairline, lineWidth: 1) }
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
    }
}
