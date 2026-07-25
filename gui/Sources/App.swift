import SwiftUI

@main
struct AgentBusApp: App {
    @StateObject private var bus = BusClient()

    var body: some Scene {
        WindowGroup("agent-bus") {
            ContentView()
                .environmentObject(bus)
                .onAppear { bus.start() }
        }
        .defaultSize(width: 1280, height: 820)
        .commands {
            CommandGroup(replacing: .newItem) {}
        }
    }
}
