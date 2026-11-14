import SwiftUI

struct RootView: View {
    @EnvironmentObject private var config: AppConfig
    @State private var tab: Tab = .home
    enum Tab: Hashable { case home, chats, bridge, settings }

    var body: some View {
        if config.jwt.isEmpty {
            LoginView()
        } else {
            TabView(selection: $tab) {
                HomeView()
                    .tabItem { Label("Home", systemImage: "house") }
                    .tag(Tab.home)
                ChatListView()
                    .tabItem { Label("Chats", systemImage: "bubble.left.and.bubble.right") }
                    .tag(Tab.chats)
                DeviceBridgeView()
                    .tabItem { Label("Bridge", systemImage: "antenna.radiowaves.left.and.right") }
                    .tag(Tab.bridge)
                SettingsView()
                    .tabItem { Label("Settings", systemImage: "gearshape") }
                    .tag(Tab.settings)
            }
        }
    }
}
