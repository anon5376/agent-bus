import SwiftUI

/// Bottom control strip. The operator sends a message or assigns a task — always
/// *as the operator*. There is deliberately no "send as" control: the broker binds
/// every sender to its token, so impersonating an agent is not possible, and the
/// panel does not pretend to offer it.
struct ComposeBar: View {
    @EnvironmentObject var bus: BusClient
    var presetTo: String?

    enum Mode: String, CaseIterable, Identifiable {
        case message = "Message"
        case task = "Assign task"
        var id: String { rawValue }
    }

    @State private var mode: Mode = .message
    @State private var to = ""
    @State private var type = "info"
    @State private var subject = ""
    @State private var messageBody = ""
    @State private var context = ""

    private var recipients: [String] { ["*"] + bus.knownAgents.map(\.id) }
    private var canSend: Bool { !to.isEmpty && !subject.isEmpty && !messageBody.isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Picker("", selection: $mode) {
                    ForEach(Mode.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented).frame(width: 200).labelsHidden()

                Label("as operator", systemImage: "person.fill")
                    .font(.system(size: 10.5)).foregroundStyle(.secondary)
                    .help("Messages are always sent as the operator; agents can only speak as themselves.")

                Picker("to", selection: $to) {
                    Text("recipient…").tag("")
                    ForEach(recipients, id: \.self) { r in
                        Text(r == "*" ? "everyone" : r).tag(r)
                    }
                }
                .frame(width: 150)

                if mode == .message {
                    Picker("", selection: $type) {
                        ForEach(["info", "question", "answer"], id: \.self) { Text($0).tag($0) }
                    }
                    .labelsHidden().frame(width: 120)
                }
                Spacer()
            }
            .font(.system(size: 11))

            TextField(mode == .message ? "Subject" : "Task title", text: $subject)
                .textFieldStyle(.roundedBorder).font(.system(size: 12))

            HStack(alignment: .top, spacing: 8) {
                TextField(mode == .message ? "Message" : "Brief — what to do, and what done looks like",
                          text: $messageBody, axis: .vertical)
                    .textFieldStyle(.roundedBorder).lineLimit(2...5).font(.system(size: 12))

                if mode == .task {
                    TextField("Context (files, constraints)", text: $context, axis: .vertical)
                        .textFieldStyle(.roundedBorder).lineLimit(2...5)
                        .font(.system(size: 12)).frame(width: 260)
                }

                Button(mode == .message ? "Send" : "Assign") { submit() }
                    .keyboardShortcut(.return, modifiers: .command)
                    .buttonStyle(.borderedProminent).tint(Palette.accent)
                    .disabled(!canSend || bus.busy)
            }
        }
        .padding(12)
        .onAppear { if to.isEmpty, let p = presetTo { to = p } }
        .onChange(of: presetTo) { _, newValue in if let newValue { to = newValue } }
    }

    private func submit() {
        let payload = (to: to, subject: subject, body: messageBody,
                       context: context, type: type, mode: mode)
        subject = ""; messageBody = ""; context = ""
        Task {
            switch payload.mode {
            case .message:
                await bus.send(to: payload.to, subject: payload.subject,
                               body: payload.body, type: payload.type)
            case .task:
                await bus.assignTask(to: payload.to, title: payload.subject,
                                     brief: payload.body, context: payload.context)
            }
        }
    }
}

/// Full task record with the operator's review controls.
struct TaskDetailSheet: View {
    @EnvironmentObject var bus: BusClient
    @Environment(\.dismiss) private var dismiss
    let task: BusTask
    @State private var feedback = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    section("Brief", task.brief)
                    if !task.context.isEmpty { section("Context", task.context) }
                    historyBlock
                }
                .padding(18)
            }
            Divider()
            controls
        }
        .frame(width: 660, height: 580)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Text(task.title).font(.system(size: 15, weight: .semibold))
                Spacer()
                Button("Close") { dismiss() }
            }
            HStack(spacing: 8) {
                Pill(text: task.stateLabel, color: task.accent)
                Text("\(task.assigner) → \(task.assignee) · round \(task.round)")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                Text(task.id).font(.system(size: 10, design: .monospaced)).foregroundStyle(.tertiary)
            }
        }
        .padding(18)
    }

    private func section(_ title: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title.uppercased()).font(.system(size: 10, weight: .semibold))
                .tracking(0.5).foregroundStyle(.secondary)
            Text(text).font(.system(size: 12.5)).foregroundStyle(.primary.opacity(0.85))
                .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                .lineSpacing(2)
        }
    }

    private var historyBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("HISTORY").font(.system(size: 10, weight: .semibold))
                .tracking(0.5).foregroundStyle(.secondary)
            ForEach(Array(task.history.enumerated()), id: \.offset) { _, event in
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(event.actor).font(.system(size: 11, weight: .semibold))
                        Text(event.kind).font(.system(size: 10)).foregroundStyle(.secondary)
                        Spacer()
                        Text(Fmt.clock.string(from: event.date))
                            .font(.system(size: 9.5, design: .monospaced)).foregroundStyle(.tertiary)
                    }
                    if !event.note.isEmpty {
                        Text(event.note).font(.system(size: 12)).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true).lineSpacing(1.5)
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(UI.card, in: RoundedRectangle(cornerRadius: 7))
            }
        }
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("Feedback to \(task.assignee)", text: $feedback, axis: .vertical)
                .textFieldStyle(.roundedBorder).lineLimit(2...4)
            HStack {
                Button("Cancel task", role: .destructive) {
                    Task {
                        await bus.cancel(taskId: task.id,
                            reason: feedback.isEmpty ? "Cancelled by the operator." : feedback)
                        dismiss()
                    }
                }
                Spacer()
                Button("Request changes") { review(false) }.disabled(feedback.isEmpty)
                Button("Accept") { review(true) }
                    .buttonStyle(.borderedProminent).tint(Palette.ok)
            }
        }
        .padding(14)
    }

    private func review(_ accepted: Bool) {
        let note = feedback.isEmpty ? "Accepted." : feedback
        Task {
            await bus.review(taskId: task.id, accepted: accepted, feedback: note)
            dismiss()
        }
    }
}
