import WidgetKit

enum PhoneCardSync {
    static func run() async {
        _ = await PhoneCardStore.refresh()
        WidgetCenter.shared.reloadAllTimelines()
    }
}
